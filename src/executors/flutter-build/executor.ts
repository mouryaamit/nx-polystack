import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import { stripExif, stripExifSummary } from '../../lib/helpers/strip-exif';

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
  const configuredRoot =
    context.projectsConfigurations?.projects?.[projectName]?.root ??
    context.workspace?.projects?.[projectName]?.root;
  const projectDir = path.join(repoRoot, configuredRoot ?? path.join('apps', projectName));

  const envFile = path.join(projectDir, 'env', `${env}.json`);
  const dartDefine = fs.existsSync(envFile) ? `--dart-define-from-file=env/${env}.json` : '';
  if (!dartDefine) {
    console.log(`ℹ No env file at ${envFile} — skipping --dart-define-from-file`);
  }

  const execOpts: ExecSyncOptions = { stdio: 'inherit', cwd: projectDir };

  if (serve) {
    const cmd = `flutter run -d web-server --web-port=${port} ${dartDefine}`.trim();
    runner(cmd, execOpts);
    return { success: true };
  }

  if (!dist) {
    throw new Error('flutter-build: "dist" option is required for non-serve builds');
  }

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

  console.log('✅ Flutter build complete');
  return { success: true };
}
