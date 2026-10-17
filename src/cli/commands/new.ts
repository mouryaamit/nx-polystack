import * as fs from 'fs';
import * as path from 'path';

import { flagString } from '../args';
import { findWorkspaceRoot } from '../context';
import { execOrThrow, hasGit } from '../exec';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { presetInfraFlags } from './infra';

export interface NewDeps {
  exec(cmd: string, args: string[], cwd: string): void;
  hasGit(): boolean;
}

const defaultDeps: NewDeps = { exec: execOrThrow, hasGit };

export async function runNew(ctx: CommandContext, deps: NewDeps = defaultDeps): Promise<number> {
  const dir = ctx.positionals[0];
  if (!dir) {
    throw new CliError(
      'a target directory is required.\n\nExample: pstack new my-workspace --ci=github-actions --llm=claude',
    );
  }

  const target = path.resolve(ctx.cwd, dir);
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new CliError(`${target} is not a directory.`);
    if (fs.readdirSync(target).length > 0) throw new CliError(`${target} is not empty.`);
  }
  const parentWs = findWorkspaceRoot(path.dirname(target));
  if (parentWs && !ctx.flags['force']) {
    throw new CliError(
      `${target} is inside an existing Nx workspace (${parentWs}). Pass --force to create it anyway.`,
    );
  }

  const baseBranch = flagString(ctx.flags, 'baseBranch') || 'master';
  if (!/^[\w./-]+$/.test(baseBranch)) {
    throw new CliError(
      `"${baseBranch}" is not a valid branch name (allowed: letters, digits, _ . / -).`,
    );
  }
  const infraOptions = await presetInfraFlags(ctx.flags);
  const skipInstall = !!ctx.flags['skipInstall'];
  const skipGit = !!ctx.flags['skipGit'];

  if (!ctx.dryRun) fs.mkdirSync(target, { recursive: true });

  const { default: presetGenerator } = await import('../../generators/preset/generator');
  await runInTree(target, ctx, (tree) =>
    presetGenerator(tree, {
      npmScope: flagString(ctx.flags, 'npmScope') || 'mouryaamit',
      baseBranch,
      ...infraOptions,
      llm: flagString(ctx.flags, 'llm'),
      projectDescription: flagString(ctx.flags, 'projectDescription'),
      // Prettier cannot resolve config for a folder that does not exist yet (dry run).
      skipFormat: ctx.dryRun || !!ctx.flags['skipFormat'],
      pluginVersion: ctx.selfVersion,
    }),
  );

  if (ctx.dryRun) {
    const gitAvailable = !skipGit && deps.hasGit();
    if (gitAvailable) console.log(`Would run: git init -b ${baseBranch}`);
    if (!skipInstall) console.log('Would run: npm install');
    if (gitAvailable) console.log('Would run: git add -A && git commit');
    return 0;
  }

  // git init precedes npm install: the generated "prepare" script runs husky, which needs .git.
  let useGit = !skipGit && deps.hasGit();
  if (!skipGit && !useGit) console.error('pstack: git not found — skipping git init.');
  if (useGit) {
    try {
      deps.exec('git', ['init', '-b', baseBranch], target);
    } catch (err) {
      useGit = false;
      console.error(
        `pstack: git init failed (${
          err instanceof Error ? err.message : String(err)
        }) — continuing without git.`,
      );
    }
  }

  if (!skipInstall) {
    try {
      deps.exec('npm', ['install'], target);
    } catch (err) {
      throw new CliError(
        `npm install failed in ${target}. Files were written; fix the error and run "npm install" there.\n` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  if (useGit) {
    try {
      deps.exec('git', ['add', '-A'], target);
      deps.exec(
        'git',
        ['commit', '--no-verify', '-m', 'chore: initial polystack workspace'],
        target,
      );
    } catch (err) {
      console.error(
        `pstack: initial commit failed (${
          err instanceof Error ? err.message : String(err)
        }). Commit manually.`,
      );
    }
  }

  const rel = path.relative(ctx.cwd, target) || '.';
  const cdLine = rel === '.' ? '' : `  cd ${rel}\n`;
  console.log(`\nWorkspace ready.\n\n${cdLine}  pstack app --type=angular --name=<name>\n`);
  return 0;
}
