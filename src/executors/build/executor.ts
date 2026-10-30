import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import { prepareEnvFile } from '../../lib/env-encryption/prepare';
import { CheckResult, listFiles, servedRoot } from '../../lib/hardening/files';
import {
  isApplicationBuilder,
  outputBase,
  sameOutput,
  ssrOption,
} from '../../lib/release/flat-output';
import { hasWebpackSriRuntime, recordHashes, swapHashes } from '../../lib/hardening/integrity';
import { checkLeaks } from '../../lib/hardening/leak-check';
import { refreshNgswHashes } from '../../lib/hardening/ngsw';
import { obfuscateOutput, Obfuscator } from '../../lib/hardening/obfuscate';
import { resolveHardening } from '../../lib/hardening/options';
import { checkSourceMaps } from '../../lib/hardening/source-maps';
import { stripHtmlComments as stripHtmlCommentsText, stripOutput } from '../../lib/hardening/strip';
import { generatorInfo } from '../../lib/helpers/build-gen';
import { injectBuildMeta } from '../../lib/helpers/inject-meta';
import { injectCspNonce, resolveNonceSettings } from '../../lib/helpers/inject-nonce';
import { injectSri } from '../../lib/helpers/inject-sri';
import { stripExif, stripExifSummary } from '../../lib/helpers/strip-exif';
import {
  placeHtaccess,
  removeHtaccessFiles,
  requireHtaccessSource,
} from '../../lib/release/htaccess';
import { resolveCiContext } from '../../lib/utils/ci-resolve';
import { BuildExecutorSchema } from './schema.d';

export type Runner = (cmd: string, opts: ExecSyncOptions) => void;

/** Test seams. */
export interface BuildSeams {
  /** Used instead of the workspace's javascript-obfuscator. */
  obfuscator?: Obfuscator;
}

const defaultRunner: Runner = (cmd, opts) => {
  console.log(`▶ ${cmd}`);
  execSync(cmd, opts);
};

export default async function buildExecutor(
  options: BuildExecutorSchema,
  context: ExecutorContext,
  runner: Runner = defaultRunner,
  seams: BuildSeams = {},
): Promise<{ success: boolean }> {
  const {
    type,
    outputPath,
    envProject,
    env,
    buildTarget,
    buildConfiguration,
    secure = false,
    nonce,
    stripHtmlComments = false,
    sri = false,
    baseHref,
    keySplit,
    domains,
    includeWww,
    onMismatch,
  } = options;

  if (!env) {
    throw new Error(
      'build executor: "env" is required — set it via Nx configurations (e.g. dev / uat / prod)',
    );
  }

  const projectName = context.projectName!;
  const repoRoot = context.root;

  const target = buildTarget ?? `${projectName}:build`;
  if (!/^[^:\s]+:[^:\s]+$/.test(target)) {
    throw new Error(
      `build executor: buildTarget "${target}" must be exactly "<project>:<target>".`,
    );
  }
  if (context.targetName && target === `${projectName}:${context.targetName}`) {
    throw new Error(
      `build executor: buildTarget "${target}" points at this target. ` +
        'Run "pstack update" (migration angular-release-target) or set buildTarget to the Angular build target.',
    );
  }

  // Invalid hardening options fail before the env files are touched or anything is built.
  const hardening = resolveHardening(options, env);
  let nonceSettings: ReturnType<typeof resolveNonceSettings>;
  try {
    nonceSettings = resolveNonceSettings(nonce);
  } catch (err) {
    throw new Error(`build executor: ${(err as Error).message}`);
  }
  hardening.warnings.forEach((w) => console.warn(`⚠ ${w}`));

  // The env's Apache config, checked before anything is built (no fallback to another env).
  const htaccessSource =
    options.htaccess === false
      ? undefined
      : requireHtaccessSource(repoRoot, projectName, envProject, env);

  const ciCtx = resolveCiContext();
  // Checked before the Angular build, so a bad buildMeta option fails fast.
  const gen = generatorInfo(repoRoot, options.buildMeta);
  // SRI for every chunk: Angular hashes them (the webpack runtime holds the lazy ones), the hashes
  // are swapped after strip/obfuscate, and aes-gcm builds require integrity at runtime.
  const chunkSri = sri && env !== 'DEV';

  const angularConfig =
    buildConfiguration ?? (env === 'PROD' ? 'production' : env === 'UAT' ? 'uat' : 'development');
  // Where the Angular build writes: the release outputPath, or (application builder with an object
  // outputPath) the build target's own base, never a browser/ subfolder. Checked before the env
  // file is touched or anything is built.
  const output = buildOutput(context, target, angularConfig, outputPath);

  const envFilePath = envFileFor(repoRoot, envProject, env);
  // One instant for the env stamp, the aes-gcm key (HKDF) and the meta timestamp_utc.
  const now = new Date();
  const prepared = prepareEnvFile({
    repoRoot,
    envProject,
    env,
    envFile: envFilePath,
    commit: ciCtx.commit,
    branch: ciCtx.branch,
    now,
    keySplit,
    domains,
    includeWww,
    onMismatch,
    requireIntegrity: chunkSri,
  });
  if (chunkSri && !prepared.keyParts) {
    console.log(
      'ℹ sri: the runtime integrity check (decrypt nothing without SRI) needs cipher aes-gcm',
    );
  }
  try {
    const outputArg = output.arg;
    const baseHrefArg = baseHref ? `--baseHref=${baseHref}` : '';
    // The env file changes per build (encryption, stamp), so the Angular build is never cached.
    const cacheArg = '--skip-nx-cache';
    const sriArg = chunkSri ? '--subresourceIntegrity' : '';
    const cmd =
      `npx nx run ${target}:${angularConfig} ${outputArg} ${baseHrefArg} ${sriArg} ${cacheArg}`
        .replace(/\s+/g, ' ')
        .trim();

    runner(cmd, { stdio: 'inherit', cwd: repoRoot });
  } catch (err) {
    try {
      prepared.restore();
    } catch (restoreErr) {
      // Keep the build error; the next release build of this env file repairs it.
      console.error(`✖ env file not restored: ${(restoreErr as Error).message}`);
    }
    throw err;
  }
  prepared.restore();

  const distDir = path.resolve(repoRoot, output.dir);
  if (output.applicationBuilder && fs.existsSync(path.join(distDir, 'browser', 'index.html'))) {
    throw new Error(
      `build executor: the build wrote ${path.join(output.dir, 'browser')}/; release builds have ` +
        `no browser/ folder. Set ${target}'s outputPath to { "base": "${output.dir}", "browser": "" } ` +
        '(pstack update does it).',
    );
  }

  // Release checks see what the Angular build produced; stripping comes before the files are
  // hashed (SRI) and stamped.
  const checkRoot = servedRoot(distDir);
  reportChecks([
    checkLeaks(checkRoot, prepared.secrets, hardening.leakCheck),
    checkSourceMaps(checkRoot, hardening.sourceMaps),
  ]);
  // Integrity Angular already wrote (sri, or subresourceIntegrity set in angular.json) must follow
  // every rewrite below, else the browser refuses the rewritten files.
  const builtWithIntegrity =
    env !== 'DEV' && (chunkSri || hasIntegrity(checkRoot) || hasWebpackSriRuntime(checkRoot));
  const originalHashes = builtWithIntegrity ? recordHashes(checkRoot) : undefined;
  const stripped = await stripOutput(checkRoot, { ...hardening, repoRoot });
  stripped.notes.forEach((n) => console.log(`ℹ ${n}`));
  const obfuscated = await obfuscateOutput(checkRoot, {
    repoRoot,
    mode: hardening.obfuscate,
    overrides: hardening.obfuscateOptions,
    obfuscator: seams.obfuscator,
  });
  if (obfuscated.files > 0) {
    console.log(
      `🔒 obfuscated ${obfuscated.files} file(s): ${kb(obfuscated.bytesBefore)} → ${kb(
        obfuscated.bytesAfter,
      )}`,
    );
  }
  if (originalHashes) {
    swapHashes(checkRoot, originalHashes);
    warnUncoveredLazyChunks(checkRoot);
  }

  // The build meta (and, aes-gcm, the key share and the asset share) go into the served
  // index.html; a build without one fails here instead of shipping without the meta.
  const servedDir = servedIndexRoot(distDir, output.dir);
  const metaHtml = path.join(servedDir, 'index.html');
  const asset = prepared.keyParts?.asset;
  if (asset) {
    fs.mkdirSync(path.join(servedDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(servedDir, 'assets', asset.name), asset.bytes);
  }

  // Every env: only images that carry EXIF are rewritten, the rest stay byte-identical.
  if (fs.existsSync(distDir)) {
    const exif = await stripExif({
      rootDir: distDir,
      log: (m) => {
        if (m.startsWith('skipped')) console.warn(`⚠ strip-exif ${m}`);
      },
    });
    console.log(`ℹ ${stripExifSummary(exif)}`);
  }

  {
    injectBuildMeta({
      indexHtmlPath: metaHtml,
      env,
      branch: ciCtx.branch,
      commit: ciCtx.commit,
      buildNumber: ciCtx.buildNumber,
      metaName: prepared.config.metaName,
      now,
      extra: prepared.keyParts ? { k: prepared.keyParts.share } : undefined,
      gen,
    });
  }

  // The served index.html: <outputPath>, or <outputPath>/browser for the application builder.
  if (fs.existsSync(path.join(checkRoot, 'index.html'))) {
    if (stripHtmlComments) {
      for (const rel of nonceSettings.files) {
        const file = path.join(checkRoot, rel);
        if (!fs.existsSync(file)) continue;
        const html = fs.readFileSync(file, 'utf8');
        const out = stripHtmlCommentsText(html);
        if (out !== html) fs.writeFileSync(file, out);
      }
    }
    if (secure) {
      injectCspNonce({ distDir, ...nonceSettings, stripComments: false });
    }

    if (sri || builtWithIntegrity) {
      injectSri({
        distDir,
        cdnAllowlist: readSriAllowlist(repoRoot),
        refresh: true,
        files: nonceSettings.files,
      });
    }
    if (chunkSri && prepared.keyParts) {
      noteExternalScripts(path.join(checkRoot, 'index.html'));
    }
  }

  // The env's .htaccess is the only one in the output (htaccess: false: none at all).
  if (fs.existsSync(distDir)) {
    if (htaccessSource) {
      const removed = placeHtaccess(htaccessSource, distDir, checkRoot);
      console.log(
        `ℹ htaccess: ${path.relative(repoRoot, htaccessSource)} → ` +
          `${path.relative(repoRoot, path.join(checkRoot, '.htaccess'))}` +
          (removed.length > 0 ? ` (removed from the build: ${removed.join(', ')})` : ''),
      );
    } else {
      const removed = removeHtaccessFiles(distDir);
      if (removed.length > 0) {
        console.log(`ℹ htaccess: off; removed ${removed.join(', ')} from the output`);
      }
    }
  }

  // Last: every rewrite above (strip, obfuscate, hashes, meta, nonce, SRI) changes files the
  // service worker hashed.
  const ngswUpdated = refreshNgswHashes(checkRoot);
  if (ngswUpdated > 0) console.log(`ℹ ngsw.json: ${ngswUpdated} hash(es) updated`);

  console.log(`✅ Build complete — type:${type}, env:${env}, output:${output.dir}`);
  return { success: true };
}

/**
 * The runtime integrity check covers same-origin scripts only; third-party ones without integrity
 * (tag managers, chat widgets) rely on the CSP allowlist. Lists their hosts.
 */
function noteExternalScripts(indexHtml: string): void {
  const html = fs.readFileSync(indexHtml, 'utf8');
  const hosts = new Set<string>();
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (/\bintegrity\s*=/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    try {
      hosts.add(new URL(src, 'https://x.invalid').host);
    } catch {
      // unreadable URL: not listed
    }
  }
  if (hosts.size > 0) {
    console.log(
      `ℹ sri: third-party scripts without integrity (${[...hosts].join(', ')}) are not checked ` +
        'by the runtime; keep them in your CSP allowlist',
    );
  }
}

/** Whether the served index.html already carries integrity attributes. */
function hasIntegrity(root: string): boolean {
  const index = path.join(root, 'index.html');
  return fs.existsSync(index) && /\bintegrity\s*=/i.test(fs.readFileSync(index, 'utf8'));
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} kB`;

/**
 * esbuild (application builder): lazy chunks are loaded by import(), which carries no hash; only
 * the webpack runtime checks lazy chunks.
 */
function warnUncoveredLazyChunks(root: string): void {
  if (hasWebpackSriRuntime(root)) return;
  const lazy = listFiles(root, ['js', 'mjs'], { skipDirs: ['assets'] }).some((f) =>
    /^chunk-[A-Z0-9]+\.m?js$/.test(path.basename(f)),
  );
  if (lazy) {
    console.warn(
      '⚠ sri: lazy chunks are not covered (the application builder loads them with import(), ' +
        'which carries no hash); scripts in index.html are',
    );
  }
}

/** Prints every warning, then fails with every error of the release checks. */
function reportChecks(results: CheckResult[]): void {
  const warnings = results.flatMap((r) => r.warnings);
  const errors = results.flatMap((r) => r.errors);
  warnings.forEach((w) => console.warn(`⚠ ${w}`));
  if (errors.length > 0) {
    throw new Error(`release checks failed:\n${errors.map((e) => `  ✖ ${e}`).join('\n')}`);
  }
}

/** The served root, which must hold an index.html for the build meta (and the aes-gcm key share). */
function servedIndexRoot(distDir: string, outputPath: string): string {
  const dir = servedRoot(distDir);
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    throw new Error(
      `build executor: index.html not found under ${outputPath}; the build meta could not be ` +
        'written',
    );
  }
  return dir;
}

/**
 * environments/<envProject>/environment.<env>.ts. DEV uses environment.ts, or environment.dev.ts
 * in the per-env layout (no environment.ts in the folder).
 */
export function envFileFor(repoRoot: string, envProject: string, env: string): string {
  const dir = path.join(repoRoot, 'environments', envProject);
  if (env !== 'DEV') return path.join(dir, `environment.${env.toLowerCase()}.ts`);
  const base = path.join(dir, 'environment.ts');
  const perEnv = path.join(dir, 'environment.dev.ts');
  return !fs.existsSync(base) && fs.existsSync(perEnv) ? perEnv : base;
}

function readSriAllowlist(repoRoot: string): string[] {
  const allowlistFile = path.join(repoRoot, 'tools', 'config', 'sri-cdn-allowlist.json');
  if (!fs.existsSync(allowlistFile)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(allowlistFile, 'utf8'));
    if (Array.isArray(raw.allow)) return raw.allow as string[];
  } catch {
    // ignore malformed config
  }
  return [];
}

interface BuildOutput {
  /** `--outputPath=…` for the Angular build, or '' when the build target's own outputPath is used. */
  arg: string;
  /** Workspace-relative folder the build writes to (and the release steps work in). */
  dir: string;
  /** The build target runs Angular's application builder. */
  applicationBuilder: boolean;
}

/**
 * Where the Angular build writes. The release outputPath is passed on (as before), except for the
 * application builder: it would put the app in <outputPath>/browser/, so its build target must
 * set `outputPath: { base, browser: "" }`. That object is used as it is (no --outputPath: a CLI
 * string would replace it) and its base must be the release outputPath. Server-rendered builds
 * are refused. Without project config in the context the release outputPath is passed on.
 */
export function buildOutput(
  context: ExecutorContext,
  buildTarget: string,
  configuration: string,
  releaseOutputPath: string,
): BuildOutput {
  const passOn: BuildOutput = {
    arg: `--outputPath=${releaseOutputPath}`,
    dir: releaseOutputPath,
    applicationBuilder: false,
  };
  const [project, name] = buildTarget.split(':');
  const target = context.projectsConfigurations?.projects?.[project]?.targets?.[name] as
    | {
        executor?: string;
        options?: Record<string, unknown>;
        configurations?: Record<string, Record<string, unknown>>;
      }
    | undefined;
  if (!target || !isApplicationBuilder(target)) return passOn;
  const options = { ...(target.options ?? {}), ...(target.configurations?.[configuration] ?? {}) };
  const where = `${buildTarget}${
    target.configurations?.[configuration] ? `:${configuration}` : ''
  }`;
  const ssr = ssrOption(options);
  if (ssr) {
    throw new Error(
      `build executor: ${where} sets "${ssr}" (server rendering); the release build is for ` +
        'browser-only apps.',
    );
  }
  const out = options['outputPath'];
  const base = outputBase(out);
  const flat = { base: base ?? releaseOutputPath, browser: '' };
  if (
    typeof out !== 'object' ||
    out === null ||
    (out as Record<string, unknown>)['browser'] !== ''
  ) {
    throw new Error(
      `build executor: ${where} uses the application builder, which writes the app to ` +
        `${base ?? releaseOutputPath}/browser/ unless outputPath.browser is "". Release builds ` +
        `have no browser/ folder: set its outputPath to ${JSON.stringify(
          flat,
        )} (pstack update does it).`,
    );
  }
  if (!base) {
    throw new Error(`build executor: ${where} has an outputPath without "base".`);
  }
  if (!sameOutput(base, releaseOutputPath)) {
    throw new Error(
      `build executor: the release outputPath is "${releaseOutputPath}" but ${where} builds to ` +
        `"${base}". Set the release target's outputPath to "${base}".`,
    );
  }
  return { arg: '', dir: base, applicationBuilder: true };
}
