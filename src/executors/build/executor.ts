import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import { prepareEnvFile } from '../../lib/env-encryption/prepare';
import { CheckResult, listFiles, servedRoot } from '../../lib/hardening/files';
import { hasWebpackSriRuntime, recordHashes, swapHashes } from '../../lib/hardening/integrity';
import { checkLeaks } from '../../lib/hardening/leak-check';
import { refreshNgswHashes } from '../../lib/hardening/ngsw';
import { obfuscateOutput, Obfuscator } from '../../lib/hardening/obfuscate';
import { resolveHardening } from '../../lib/hardening/options';
import { checkSourceMaps } from '../../lib/hardening/source-maps';
import { stripOutput } from '../../lib/hardening/strip';
import { injectBuildMeta } from '../../lib/helpers/inject-meta';
import { injectCspNonce } from '../../lib/helpers/inject-nonce';
import { injectSri } from '../../lib/helpers/inject-sri';
import { stripExif } from '../../lib/helpers/strip-exif';
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
  hardening.warnings.forEach((w) => console.warn(`⚠ ${w}`));

  const ciCtx = resolveCiContext();
  // SRI for every chunk: Angular hashes them (the webpack runtime holds the lazy ones), the hashes
  // are swapped after strip/obfuscate, and aes-gcm builds require integrity at runtime.
  const chunkSri = sri && env !== 'DEV';

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
    const angularConfig =
      buildConfiguration ?? (env === 'PROD' ? 'production' : env === 'UAT' ? 'uat' : 'development');
    const outputArg = `--outputPath=${outputPath}`;
    const baseHrefArg = baseHref ? `--baseHref=${baseHref}` : '';
    // The env file changes per build (encryption, stamp), so the Angular build is never cached.
    const cacheArg = env === 'DEV' ? '' : '--skip-nx-cache';
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

  const distDir = path.resolve(repoRoot, outputPath);

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

  // aes-gcm: the meta key share (and the asset share) must reach the served index.html, else the
  // app cannot decrypt. cryptojs builds keep the meta in <outputPath>/index.html when present.
  const servedDir = prepared.keyParts ? gcmServedRoot(distDir, outputPath) : distDir;
  const metaHtml = path.join(servedDir, 'index.html');
  const asset = prepared.keyParts?.asset;
  if (asset) {
    fs.mkdirSync(path.join(servedDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(servedDir, 'assets', asset.name), asset.bytes);
  }

  if (env === 'PROD' && fs.existsSync(distDir)) {
    await stripExif({ rootDir: distDir });
  }

  if (fs.existsSync(metaHtml)) {
    injectBuildMeta({
      indexHtmlPath: metaHtml,
      env,
      branch: ciCtx.branch,
      commit: ciCtx.commit,
      buildNumber: ciCtx.buildNumber,
      metaName: prepared.config.metaName,
      now,
      extra: prepared.keyParts ? { k: prepared.keyParts.share } : undefined,
    });
  }

  // The served index.html: <outputPath>, or <outputPath>/browser for the application builder.
  if (fs.existsSync(path.join(checkRoot, 'index.html'))) {
    if (secure) {
      injectCspNonce({ distDir });
    }

    if (sri || builtWithIntegrity) {
      injectSri({ distDir, cdnAllowlist: readSriAllowlist(repoRoot), refresh: true });
    }
    if (chunkSri && prepared.keyParts) {
      noteExternalScripts(path.join(checkRoot, 'index.html'));
    }
  }

  // Last: every rewrite above (strip, obfuscate, hashes, meta, nonce, SRI) changes files the
  // service worker hashed.
  const ngswUpdated = refreshNgswHashes(checkRoot);
  if (ngswUpdated > 0) console.log(`ℹ ngsw.json: ${ngswUpdated} hash(es) updated`);

  console.log(`✅ Build complete — type:${type}, env:${env}, output:${outputPath}`);
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

/** servedRoot for aes-gcm builds, which cannot run without an index.html for the meta key share. */
function gcmServedRoot(distDir: string, outputPath: string): string {
  const dir = servedRoot(distDir);
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    throw new Error(
      `aes-gcm build: index.html not found under ${outputPath}; the key share could not be written`,
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
