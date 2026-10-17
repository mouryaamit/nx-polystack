import { flagBoolean, flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

const EXAMPLE = 'pstack shared --app=portal,admin';

/** pstack shared (--app=a,b | --all) [--dry-run]: wire the shared assets/styles folders. */
export async function runShared(ctx: CommandContext): Promise<number> {
  if (ctx.flags['app'] === true) throw new CliError('--app needs a value, e.g. --app=portal.');
  const projects = flagString(ctx.flags, 'app')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const all = ctx.flags['all'] !== undefined && flagBoolean(ctx.flags, 'all');
  if (all === (projects !== undefined && projects.length > 0)) {
    throw new CliError(
      `Name the apps with --app=<a,b> or pass --all (one of them).\n\nExample: ${EXAMPLE}`,
    );
  }
  const root = requireWorkspace(ctx.cwd, 'shared');
  const { default: sharedLibsGenerator } = await import('../../generators/shared-libs/generator');
  try {
    await runInTree(root, ctx, (tree) => sharedLibsGenerator(tree, { projects, all }));
  } catch (err) {
    throw new CliError((err as Error).message.replace(/^shared-libs generator: /, ''));
  }
  return 0;
}
