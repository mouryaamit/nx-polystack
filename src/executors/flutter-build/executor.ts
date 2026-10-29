import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import { stripHtmlComments as stripHtmlCommentsText } from '../../lib/hardening/strip';
import { generatorInfo } from '../../lib/helpers/build-gen';
import { injectBuildMeta } from '../../lib/helpers/inject-meta';
import { injectCspNonce, resolveNonceSettings } from '../../lib/helpers/inject-nonce';
import { stripExif, stripExifSummary } from '../../lib/helpers/strip-exif';
import {
  ENVIRONMENTS_DIR,
  placeHtaccess,
  removeHtaccessFiles,
  requireHtaccessSource,
} from '../../lib/release/htaccess';
import { resolveCiContext } from '../../lib/utils/ci-resolve';

import { FlutterBuildExecutorSchema } from './schema.d';

export type Runner = (cmd: string, opts: ExecSyncOptions) => void;

const defaultRunner: Runner = (cmd, opts) => {
  console.log(`▶ ${cmd}`);
  execSync(cmd, opts);
};

export default async function flutterBuildExecutor(
  options: FlutterBuildExecutorSchema,
  context: ExecutorContext,
  runner: Runner = defaultRunner,
): Promise<{ success: boolean }> {
  const { target = 'web', env = 'dev', dist, baseHref, serve = false, obfuscate = false } = options;
  const port = options.port ?? 4200;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`flutter-build: "port" must be a whole number from 1 to 65535 (got ${port})`);
  }
  const projectName = context.projectName!;
  const repoRoot = context.root;
  // Migrated projects keep their source root; generated ones live in apps/<name>.
  const configuredRoot = context.projectsConfigurations?.projects?.[projectName]?.root;
  const projectDir = path.join(repoRoot, configuredRoot ?? path.join('apps', projectName));

  // Env values: environments/<envProject>/environment.<env>.json (every env file of the
  // workspace lives under environments/). A missing file fails: the app would build without them.
  const envProject = options.envProject ?? projectName;
  const envRel = `${ENVIRONMENTS_DIR}/${envProject}/environment.${env}.json`;
  const envFile = path.join(repoRoot, envRel);
  if (!fs.existsSync(envFile)) {
    const old = path.join(projectDir, 'env', `${env}.json`);
    throw new Error(
      `flutter-build: ${projectName}: ${envRel} not found` +
        (fs.existsSync(old)
          ? ` (the app still has ${path.relative(
              repoRoot,
              old,
            )}; pstack update moves the env files to ${ENVIRONMENTS_DIR}/${envProject}/).`
          : '. Create it with the values for --dart-define-from-file ({} for none).'),
    );
  }
  const dartDefine = `--dart-define-from-file=${path
    .relative(projectDir, envFile)
    .split(path.sep)
    .join('/')}`;

  const execOpts: ExecSyncOptions = { stdio: 'inherit', cwd: projectDir };

  if (serve) {
    const cmd = `flutter run -d web-server --web-port=${port} ${dartDefine}`.trim();
    runner(cmd, execOpts);
    return { success: true };
  }

  if (!dist) {
    throw new Error('flutter-build: "dist" option is required for non-serve builds');
  }
  // Checked before the Flutter build, so a bad buildMeta or nonce option fails fast.
  const gen = generatorInfo(repoRoot, options.buildMeta);
  let nonceSettings: ReturnType<typeof resolveNonceSettings>;
  try {
    nonceSettings = resolveNonceSettings(options.nonce);
  } catch (err) {
    throw new Error(`flutter-build: ${(err as Error).message}`);
  }
  if (target !== 'web' && (options.secure || options.stripHtmlComments)) {
    console.log(`ℹ secure / stripHtmlComments ignored for ${target}: they apply to web pages.`);
  }
  // Web: the env's Apache config, checked before building (no fallback to another env).
  const htaccessSource =
    target === 'web' && options.htaccess !== false
      ? requireHtaccessSource(repoRoot, projectName, envProject, env)
      : undefined;

  const outRel = path.relative(projectDir, path.join(repoRoot, dist));
  const baseHrefArg = baseHref ? `--base-href ${baseHref}` : '';

  const obfuscateArgs = (t: string): string => {
    if (!obfuscate) return '';
    if (t === 'web') {
      console.log(
        'ℹ --obfuscate ignored for web target. Use security scripts against the dist tree instead.',
      );
      return '';
    }
    const symbolsDir = path.join(repoRoot, 'dist', 'symbols', projectName, env, t);
    fs.mkdirSync(symbolsDir, { recursive: true });
    const symbolsRel = path.relative(projectDir, symbolsDir);
    console.log(`ℹ --obfuscate: debug symbols → ${symbolsDir}`);
    return `--obfuscate --split-debug-info=${symbolsRel}`;
  };

  let cmd: string;
  if (target === 'web') {
    cmd = `flutter build web --release ${baseHrefArg} --output ${outRel} ${dartDefine} --dart-define=FLUTTER_WEB_USE_SKIA=false ${obfuscateArgs(
      'web',
    )}`;
  } else if (target === 'apk') {
    cmd = `flutter build apk --release ${dartDefine} ${obfuscateArgs('apk')}`;
  } else if (target === 'ios') {
    cmd = `flutter build ios --release ${dartDefine} ${obfuscateArgs('ios')}`;
  } else {
    throw new Error(`flutter-build: unknown target "${target}"`);
  }

  runner(cmd.replace(/\s+/g, ' ').trim(), execOpts);

  const outDir = path.join(repoRoot, dist);
  if (options.stripExif === false) {
    if (target === 'web') console.log('ℹ strip-exif: off (stripExif: false)');
  } else if (target !== 'web') {
    if (options.stripExif === true) {
      console.log(`ℹ stripExif ignored for ${target}: the images are packed into the app bundle.`);
    }
  } else if (fs.existsSync(outDir)) {
    const exif = await stripExif({
      rootDir: outDir,
      log: (m) => {
        if (m.startsWith('skipped')) console.warn(`⚠ strip-exif ${m}`);
      },
    });
    console.log(`ℹ ${stripExifSummary(exif)}`);
  }

  // Web: the env's .htaccess is the only one in the output (htaccess: false: none at all).
  if (target === 'web' && fs.existsSync(outDir)) {
    if (htaccessSource) {
      const removed = placeHtaccess(htaccessSource, outDir, outDir);
      console.log(
        `ℹ htaccess: ${path.relative(repoRoot, htaccessSource)} → ${path.join(dist, '.htaccess')}` +
          (removed.length > 0 ? ` (removed: ${removed.join(', ')})` : ''),
      );
    } else {
      const removed = removeHtaccessFiles(outDir);
      if (removed.length > 0) console.log(`ℹ htaccess: off; removed ${removed.join(', ')}`);
    }
  }

  // Web: the same build meta as Angular release builds (env, time, branch, commit, tool).
  const indexHtml = path.join(outDir, 'index.html');
  if (target === 'web' && fs.existsSync(indexHtml)) {
    const ci = resolveCiContext();
    injectBuildMeta({
      indexHtmlPath: indexHtml,
      env: env.toUpperCase(),
      branch: ci.branch,
      commit: ci.commit,
      buildNumber: ci.buildNumber,
      gen,
    });
  }

  // Web: HTML comments out and the CSP nonce placeholder on the page's tags, as Angular release
  // builds do (Flutter's inline loader script keeps its body byte for byte).
  if (target === 'web' && fs.existsSync(outDir)) {
    if (options.stripHtmlComments) {
      for (const rel of nonceSettings.files) {
        const file = path.join(outDir, rel);
        if (!fs.existsSync(file)) continue;
        const html = fs.readFileSync(file, 'utf8');
        const out = stripHtmlCommentsText(html);
        if (out !== html) fs.writeFileSync(file, out);
      }
    }
    if (options.secure) {
      const written = injectCspNonce({ distDir: outDir, ...nonceSettings, stripComments: false });
      console.log(`ℹ csp nonce: ${written.length > 0 ? written.join(', ') : 'no page changed'}`);
    }
  }

  console.log('✅ Flutter build complete');
  return { success: true };
}
