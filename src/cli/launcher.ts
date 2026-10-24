import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { installedVersion } from '../lib/utils/devkit-pin';

import type { Flags } from './args';
import type { LocalPlugin } from './context';
import { CliError } from './types';
import { compareVersions } from './versions';

/** Commands the global CLI always runs itself. */
export const NEVER_DELEGATE = new Set(['', 'help', 'new', 'update', '_migrate', 'inspect']);

/** Generator commands that act on the workspace (run from its root when delegated). */
export const WORKSPACE_COMMANDS = new Set([
  'adopt',
  'app',
  'env',
  'lib',
  'llm',
  'migrate',
  'infra',
  'encryption',
  'hardening',
  'build',
  'release',
  'csp',
  'shared',
  'upgrade',
]);

/** First plugin version whose CLI has each command; older pinned copies cannot run them. */
export const MIN_LOCAL_VERSION: Readonly<Record<string, string>> = {
  lib: '0.6.0',
  llm: '0.7.0',
  migrate: '0.12.0',
  infra: '0.9.0',
  encryption: '0.25.0',
  hardening: '0.30.0',
  build: '0.32.0',
  release: '0.32.0',
  csp: '0.33.0',
  shared: '0.35.0',
  upgrade: '1.2.12',
  adopt: '1.7.1',
};

/** First plugin version that understands a flag of a command (checked when the flag is given). */
export const MIN_LOCAL_FLAG_VERSION: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  app: {
    dir: '0.17.0',
    baseHref: '0.32.0',
    port: '0.35.0',
    envLayout: '0.35.0',
    from: '1.2.0',
  },
  env: { app: '0.34.0', all: '0.34.0', from: '0.34.0', baseHref: '0.34.0', domains: '0.34.0' },
  lib: { dir: '0.19.0' },
  csp: { import: '0.38.0', nonceSource: '1.2.5', env: '1.5.5' },
  infra: { lintStaged: '0.36.0' },
  adopt: {
    compare: '1.8.0',
    removeOldScripts: '1.8.0',
    report: '1.8.5',
    noReport: '1.8.5',
    oldDir: '1.8.5',
  },
  migrate: {
    rollback: '0.13.0',
    config: '0.14.0',
    minConfidence: '0.15.0',
    dir: '0.16.0',
    noRewriteImports: '0.21.0',
    rewriteImports: '0.21.0',
    newAdapter: '0.22.0',
  },
};

/** Path flags resolved against the caller's cwd, so they survive delegating from another cwd. */
const PATH_FLAGS: Readonly<Record<string, readonly string[]>> = {
  migrate: ['source', 'config'],
  build: ['report'],
  csp: ['import'],
};

/** Path flags that may also hold plain text: made absolute only when the file exists. */
const PATH_FLAGS_IF_FILE: Readonly<Record<string, readonly string[]>> = {
  csp: ['import'],
};

/**
 * argv for the delegated CLI: relative path flags (e.g. migrate --source) made absolute when
 * the delegate runs in a different directory than the caller.
 */
export function delegationArgs(
  command: string,
  argv: string[],
  cwd: string,
  delegateCwd: string,
): string[] {
  const flags = PATH_FLAGS[command];
  if (!flags || path.resolve(cwd) === path.resolve(delegateCwd)) return argv;
  return argv.map((arg) => {
    for (const flag of flags) {
      const prefix = `--${flag}=`;
      if (arg.startsWith(prefix)) {
        const value = arg.slice(prefix.length);
        if (!value || path.isAbsolute(value)) return arg;
        const resolved = path.resolve(cwd, value);
        if (PATH_FLAGS_IF_FILE[command]?.includes(flag) && !fs.existsSync(resolved)) return arg;
        return `${prefix}${resolved}`;
      }
    }
    return arg;
  });
}

/**
 * Throws when the workspace's pinned plugin is too old for `command` (it would only print
 * "Unknown command"). Unreadable versions are let through.
 */
export function assertLocalSupports(command: string, localVersion: string, flags?: Flags): void {
  const needs: [string, string][] = [];
  const min = MIN_LOCAL_VERSION[command];
  if (min) needs.push([`pstack ${command}`, min]);
  for (const [flag, v] of Object.entries(MIN_LOCAL_FLAG_VERSION[command] ?? {})) {
    if (flags && flags[flag] !== undefined && flags[flag] !== false) {
      const kebab = flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      needs.push([`pstack ${command} --${kebab}`, v]);
    }
  }
  for (const [what, version] of needs) {
    let cmp: number;
    try {
      cmp = compareVersions(localVersion, version);
    } catch {
      return;
    }
    if (cmp < 0) {
      throw new CliError(
        `${what} needs nx-polystack >= ${version} in this workspace (found ${localVersion}). ` +
          'Run "pstack update" first.',
      );
    }
  }
}

export interface DelegationInput {
  command: string;
  flags: Flags;
  env: NodeJS.ProcessEnv;
  selfRoot: string;
  local: LocalPlugin | null;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function shouldDelegate(i: DelegationInput): boolean {
  if (!i.local) return false;
  if (i.env['PSTACK_DELEGATED'] === '1') return false;
  if (NEVER_DELEGATE.has(i.command)) return false;
  if (i.flags['help'] || i.flags['h'] || i.flags['version'] || i.flags['v']) return false;
  return real(i.local.root) !== real(i.selfRoot);
}

/** Run another pstack CLI with the given args; returns its exit code. */
export function delegate(cliPath: string, args: string[], cwd: string): number {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, PSTACK_DELEGATED: '1' },
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

export function upgradeHint(localVersion: string, selfVersion: string): string | null {
  let cmp: number;
  try {
    cmp = compareVersions(localVersion, selfVersion);
  } catch {
    return null;
  }
  if (cmp >= 0) return null;
  return (
    `pstack: workspace uses nx-polystack v${localVersion}, global CLI is v${selfVersion} — ` +
    `run "pstack update" to upgrade.`
  );
}

/** Nx majors the plugin loads on (package.json peer range `>=17.0.0 <23.0.0`). */
export const NX_MAJORS = { min: 17, max: 22 };

/** Commands that need the workspace on a supported Nx with a matching @nx/devkit. */
const NEEDS_SUPPORTED_NX = new Set(
  [...WORKSPACE_COMMANDS, 'update'].filter((c) => c !== 'upgrade'),
);

const majorOf = (v: string): number => Number(/^(\d+)\./.exec(v)?.[1] ?? NaN);

/**
 * Why `command` cannot run in this workspace, or null: an Nx outside 17–22 (the plugin does not
 * load there; npm only reports a peer conflict), or an installed @nx/devkit of another major
 * than nx (npm resolves the plugin's devkit peer to the newest one when the workspace does not
 * pin it). Workspaces without node_modules/nx are let through.
 */
export function workspaceNxProblem(command: string, wsRoot: string): string | null {
  if (!NEEDS_SUPPORTED_NX.has(command)) return null;
  const nx = installedVersion(wsRoot, 'nx');
  if (!nx) return null;
  const major = majorOf(nx);
  if (Number.isNaN(major)) return null;
  if (major < NX_MAJORS.min) {
    return (
      `this workspace is on Nx ${nx}; nx-polystack needs Nx ${NX_MAJORS.min}-${NX_MAJORS.max}. ` +
      'Move it first with: pstack upgrade nx (one commit per Nx major, Angular unchanged).'
    );
  }
  if (major > NX_MAJORS.max) {
    return `this workspace is on Nx ${nx}; nx-polystack supports Nx ${NX_MAJORS.min}-${NX_MAJORS.max}.`;
  }
  // pstack update installs @nx/devkit of the workspace's Nx itself.
  const devkit = command === 'update' ? undefined : installedVersion(wsRoot, '@nx/devkit');
  if (devkit && majorOf(devkit) !== major) {
    return (
      `@nx/devkit ${devkit} does not match nx ${nx}. Pin it to the workspace's Nx: ` +
      `npm i -D @nx/devkit@${nx}`
    );
  }
  return null;
}
