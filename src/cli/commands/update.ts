import * as fs from 'fs';
import * as path from 'path';

import { flagString } from '../args';
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
}

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
};

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
  try {
    deps.exec(
      'npm',
      [
        'install',
        `${PLUGIN_NAME}@${formatPluginSpec(target.to)}`,
        pin.field === 'dependencies' ? '--save-prod' : '--save-dev',
        ...pinInstallFlags(),
      ],
      root,
    );
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

  const code = deps.runLocalMigrate(local.cliPath, pin.version, target.to, root, ctx.verbose);
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
