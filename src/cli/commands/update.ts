import * as fs from 'fs';
import * as path from 'path';

import { devkitPinFor, installedVersion as installedPackage } from '../../lib/utils/devkit-pin';
import { loadJsonc, restoreJsonLayouts, snapshotJsonConfigs } from '../../lib/utils/json-layout';
import { flagBoolean, flagString } from '../args';
import { findWorkspaceRoot, resolveLocalPlugin } from '../context';
import { execOrThrow, gitStatus } from '../exec';
import { installSource } from '../install-source';
import { delegate } from '../launcher';
import { CliError, CommandContext } from '../types';
import { findPluginPin, resolveTarget } from '../update-plan';
import {
  compareVersions,
  formatPluginSpec,
  normalizeVersion,
  pinInstallFlags,
  PLUGIN_NAME,
} from '../versions';

export interface UpdateDeps {
  exec(cmd: string, args: string[], cwd: string): void;
  /** Porcelain status text, or null when not a git repo. */
  gitStatus(cwd: string): string | null;
  /** Run the installed plugin's `_migrate`; returns its exit code. */
  runLocalMigrate(
    cliPath: string,
    from: string,
    to: string,
    cwd: string,
    verbose?: boolean,
  ): number;
  /** Run the installed plugin's CLI with these arguments; returns its exit code. */
  runLocal?(cliPath: string, args: string[], cwd: string): number;
}

/** First plugin version whose `_migrate` takes --only and --list. */
export const RUN_MIGRATION_VERSION = '1.8.6';

/** Arguments for the child `_migrate` process. */
export function migrateArgs(from: string, to: string, verbose = false): string[] {
  return ['_migrate', `--from=${from}`, `--to=${to}`, ...(verbose ? ['--verbose'] : [])];
}

/**
 * The target version asked for: `pstack update 1.2.0` or `--to=1.2.0` (both may be given if they
 * agree), or undefined for the global CLI's own version.
 */
export function requestedVersion(
  positionals: string[],
  toFlag: string | undefined,
): string | undefined {
  if (positionals.length > 1) {
    throw new CliError(`pstack update takes one version, got: ${positionals.join(' ')}`);
  }
  const arg = positionals[0];
  if (arg === undefined) return toFlag;
  const version = normalizeVersion(arg);
  if (toFlag !== undefined && normalizeVersion(toFlag) !== version) {
    throw new CliError(`"${arg}" and --to=${toFlag} name different versions; give one.`);
  }
  return version;
}

const defaultDeps: UpdateDeps = {
  exec: execOrThrow,
  gitStatus,
  runLocalMigrate: (cliPath, from, to, cwd, verbose) =>
    delegate(cliPath, migrateArgs(from, to, verbose), cwd),
  runLocal: (cliPath, args, cwd) => delegate(cliPath, args, cwd),
};

/**
 * `pstack update --run-migration=a,b`: runs those migrations of the installed plugin again,
 * whatever their version (an update only runs the ones newer than the version it starts from).
 * `pstack update --list-migrations`: prints them.
 */
function runNamedMigrations(ctx: CommandContext, root: string, deps: UpdateDeps): number {
  const local = resolveLocalPlugin(root);
  if (!local) {
    throw new CliError('nx-polystack is not installed in this workspace; run npm install first.');
  }
  if (compareVersions(local.version, RUN_MIGRATION_VERSION) < 0) {
    throw new CliError(
      `the workspace has nx-polystack v${local.version}; --run-migration and --list-migrations ` +
        `need v1.8.7 or later in the workspace. Run "pstack update" first.`,
    );
  }
  const run = deps.runLocal ?? ((cli, args, cwd) => delegate(cli, args, cwd));
  if (flagBoolean(ctx.flags, 'listMigrations')) {
    return run(local.cliPath, ['_migrate', '--list'], root);
  }
  const names = flagString(ctx.flags, 'runMigration')
    ?.split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names || names.length === 0) {
    throw new CliError(
      '--run-migration needs migration names, e.g. --run-migration=flutter-web-platform ' +
        '(pstack update --list-migrations lists them).',
    );
  }
  if (!ctx.dryRun && !ctx.flags['allowDirty']) {
    const status = deps.gitStatus(root);
    if (status !== null && status.trim() !== '') {
      throw new CliError(
        'the workspace has uncommitted changes. Commit or stash first, or pass --allow-dirty.',
      );
    }
  }
  const jsonc = loadJsonc(root);
  const snapshot = jsonc ? snapshotJsonConfigs(root) : null;
  const code = run(
    local.cliPath,
    [
      '_migrate',
      `--only=${names.join(',')}`,
      ...(ctx.verbose ? ['--verbose'] : []),
      ...(ctx.dryRun ? ['--dry-run'] : []),
    ],
    root,
  );
  if (jsonc && snapshot) {
    const kept = restoreJsonLayouts(root, snapshot, jsonc);
    if (kept.length > 0) {
      console.log(`\nKept the existing layout of ${kept.join(', ')} (only changed values moved).`);
    }
  }
  return code;
}

export async function runUpdate(
  ctx: CommandContext,
  deps: UpdateDeps = defaultDeps,
): Promise<number> {
  const root = findWorkspaceRoot(ctx.cwd);
  if (!root) {
    throw new CliError(
      'no nx.json found in this directory or any parent. Run "pstack update" inside a workspace.',
    );
  }

  const pkgPath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  if (!fs.existsSync(pkgPath)) throw new CliError(`no package.json at ${root}`);
  if (ctx.flags['runMigration'] !== undefined || ctx.flags['listMigrations'] !== undefined) {
    if (ctx.positionals.length > 0 || ctx.flags['to'] !== undefined) {
      throw new CliError(
        '--run-migration and --list-migrations use the installed plugin; give no version.',
      );
    }
    return runNamedMigrations(ctx, root, deps);
  }
  if (ctx.flags['to'] === true) {
    throw new CliError('--to requires a version, e.g. --to=0.3.0');
  }
  const toVersion = requestedVersion(ctx.positionals, flagString(ctx.flags, 'to'));
  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const installedVersion = resolveLocalPlugin(root)?.version;
  const pin = findPluginPin(
    JSON.parse(pkgText.replace(/^\uFEFF/, '')),
    ctx.selfVersion,
    installedVersion,
  );
  if (pin.fromInstalled) {
    console.log(
      `${pin.field}: "${pin.spec}" is not a version pin; migrating from the installed v${pin.version}.`,
    );
  }
  if (pin.range) {
    // ^x.y.z may have installed a newer version: migrate from what is installed.
    const installed = installedVersion;
    if (
      installed &&
      /^\d+\.\d+\.\d+$/.test(installed) &&
      compareVersions(installed, pin.version) > 0
    ) {
      pin.version = installed;
    }
  }
  const target = resolveTarget(pin.version, toVersion, ctx.selfVersion, !!ctx.flags['force']);

  // An unreadable pin on the current version is still rewritten to a normal pin.
  if (target.action === 'noop' && !pin.fromInstalled) {
    console.log(`Already on nx-polystack v${target.to}.`);
    return 0;
  }

  console.log(`${pin.field}: ${pin.spec} → ${formatPluginSpec(target.to)}`);

  if (ctx.dryRun) {
    console.log(
      'Dry run — nothing changed. Pending migrations ship with the target version and run after it is installed.',
    );
    return 0;
  }

  if (!ctx.flags['allowDirty']) {
    const status = deps.gitStatus(root);
    if (status !== null && status.trim() !== '') {
      throw new CliError(
        'the workspace has uncommitted changes. Commit or stash first, or pass --allow-dirty.',
      );
    }
  }

  const lockText = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
  const restore = (): void => {
    fs.writeFileSync(pkgPath, pkgText);
    if (lockText !== null) fs.writeFileSync(lockPath, lockText);
    else fs.rmSync(lockPath, { force: true });
  };

  // An explicit install: a plain "npm install" after editing a git-tag spec does not refetch.
  // @nx/devkit of the workspace's Nx in the same install: left to npm, the plugin's devkit peer
  // resolves to the newest Nx and the install fails (ERESOLVE) on an older workspace.
  const devkit = devkitPinFor(
    JSON.parse(pkgText.replace(/^\uFEFF/, '')),
    installedPackage(root, 'nx'),
  );
  try {
    deps.exec(
      'npm',
      [
        'install',
        `${PLUGIN_NAME}@${formatPluginSpec(target.to)}`,
        ...(devkit ? [`@nx/devkit@${devkit}`] : []),
        pin.field === 'dependencies' ? '--save-prod' : '--save-dev',
        ...pinInstallFlags(),
        ...(devkit && !pinInstallFlags().includes('--save-exact') ? ['--save-exact'] : []),
      ],
      root,
    );
    if (devkit) console.log(`@nx/devkit pinned to ${devkit} (the workspace's Nx).`);
  } catch (err) {
    restore();
    throw new CliError(
      'npm install failed; package.json and package-lock.json were restored.\n' +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const local = resolveLocalPlugin(root);
  if (!local || local.version !== target.to) {
    restore();
    throw new CliError(
      `expected nx-polystack v${target.to} in node_modules after install, found ` +
        `${
          local ? `v${local.version}` : 'nothing'
        }. package.json and package-lock.json were restored; ` +
        'node_modules may now hold another version — run npm install to resync.',
    );
  }

  if (target.action === 'noop') {
    console.log(`\nPinned nx-polystack v${target.to}. Review with "git diff".`);
    return 0;
  }

  // Migrations write JSON through formatFiles/writeJson, which re-lays-out whole files; put the
  // workspace's own layout back afterwards so the diff shows only what changed.
  const jsonc = loadJsonc(root);
  const snapshot = jsonc ? snapshotJsonConfigs(root) : null;
  const code = deps.runLocalMigrate(local.cliPath, pin.version, target.to, root, ctx.verbose);
  if (jsonc && snapshot) {
    const kept = restoreJsonLayouts(root, snapshot, jsonc);
    if (kept.length > 0) {
      console.log(`\nKept the existing layout of ${kept.join(', ')} (only changed values moved).`);
    }
  }
  if (code !== 0) {
    console.error(
      `\nThe plugin is already on v${target.to}, but migrations from v${pin.version} did not all apply.\n` +
        'To retry from scratch: git checkout -- . && npm install, then run "pstack update" again.\n' +
        `Or, after fixing the cause, rerun only the migrations: npx pstack _migrate --from=${pin.version} --to=${target.to}`,
    );
    return code;
  }

  console.log(`\nUpdated nx-polystack v${pin.version} → v${target.to}. Review with "git diff".`);
  const stale = githubWorkflows(root);
  if (installSource().kind === 'npm' && stale.length > 0) {
    console.log(
      `\nThe plugin now comes from npm, but ${stale.join(', ')} still install it from GitHub ` +
        '(PSTACK_REPO_TOKEN, gh release). Rewrite them with: pstack infra --with=ci,upgrades --force',
    );
  }
  return 0;
}

/** GitHub workflows written for a plugin installed from a GitHub repo. */
function githubWorkflows(root: string): string[] {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => /PSTACK_REPO_TOKEN/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    .map((f) => `.github/workflows/${f}`);
}
