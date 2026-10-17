import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { Flags } from './args';
import type { LocalPlugin } from './context';
import { CliError } from './types';
import { compareVersions } from './versions';

/** Commands the global CLI always runs itself. */
export const NEVER_DELEGATE = new Set(['', 'help', 'new', 'update', '_migrate']);

/** Generator commands that act on the workspace (run from its root when delegated). */
export const WORKSPACE_COMMANDS = new Set([
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
  csp: { import: '0.38.0' },
  infra: { lintStaged: '0.36.0' },
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
