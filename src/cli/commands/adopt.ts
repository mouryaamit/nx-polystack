import { flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

/** pstack adopt [--app=a,b] [--no-scripts]: Angular apps on their own build scripts → release target. */
export async function runAdopt(ctx: CommandContext): Promise<number> {
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
      }),
    );
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError((err as Error).message.replace(/^adopt: /, ''));
  }
  return 0;
}
