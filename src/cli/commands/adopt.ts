import { flagBoolean, flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

/** --report=<path> | --report=false | --no-report; undefined when not given. */
function reportOption(ctx: CommandContext): string | false | undefined {
  if (ctx.flags['noReport'] === true) return false;
  const v = ctx.flags['report'];
  if (v === undefined) return undefined;
  if (v === true)
    throw new CliError('--report needs a path (e.g. --report=docs/adopt.md), or use --no-report.');
  if (v === false || /^(false|no|off|0)$/i.test(v)) return false;
  return v;
}

/**
 * pstack adopt [--app=a,b] [--no-scripts] [--remove-old-scripts] [--report=<path>|--no-report]: Angular apps on their own build
 * scripts → release target. pstack adopt --compare --app=<app>: old build vs release target.
 */
export async function runAdopt(ctx: CommandContext): Promise<number> {
  if (flagBoolean(ctx.flags, 'compare')) {
    const { runAdoptCompare } = await import('./adopt-compare');
    return runAdoptCompare(ctx);
  }
  if (ctx.flags['app'] === true)
    throw new CliError('--app needs a value (e.g. --app=portal,admin).');
  const projects = flagString(ctx.flags, 'app')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const root = requireWorkspace(ctx.cwd, 'adopt');
  const { default: adoptGenerator } = await import('../../generators/adopt/generator');
  try {
    await runInTree(root, ctx, (tree) =>
      adoptGenerator(tree, {
        projects,
        scripts: ctx.flags['scripts'] === false ? false : ctx.flags['noScripts'] !== true,
        removeOldScripts: flagBoolean(ctx.flags, 'removeOldScripts'),
        report: reportOption(ctx),
      }),
    );
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError((err as Error).message.replace(/^adopt: /, ''));
  }
  return 0;
}
