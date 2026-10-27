import { parseDir } from '../../lib/utils/app-dir';
import { flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

const EXAMPLE = 'Example: pstack lib --type=angular --name=ui';

export async function runLib(ctx: CommandContext): Promise<number> {
  const name = flagString(ctx.flags, 'name');
  const type = flagString(ctx.flags, 'type');
  if (!name) {
    throw new CliError(`--name is required.\n\n${EXAMPLE}`);
  }
  if (!type) {
    throw new CliError(
      '--type is required (ts | angular | ionic | flutter | assets | styles | state | ' +
        `design-tokens | session | pii).\n\n${EXAMPLE}`,
    );
  }
  if (ctx.flags['dir'] === true) {
    throw new CliError('--dir needs a value: --dir=<folder>[/<folder>] (e.g. --dir=forms).');
  }
  const dir = flagString(ctx.flags, 'dir');
  try {
    parseDir(dir, 'lib', 2);
  } catch (err) {
    throw new CliError((err as Error).message.replace(/^lib: /, ''));
  }
  const root = requireWorkspace(ctx.cwd, 'lib');
  const { default: libGenerator } = await import('../../generators/lib/generator');
  type Schema = Parameters<typeof libGenerator>[1];
  await runInTree(root, ctx, (tree) =>
    libGenerator(tree, {
      name,
      type: type as Schema['type'],
      scope: flagString(ctx.flags, 'scope'),
      dir,
      variant: flagString(ctx.flags, 'variant'),
      prefix: flagString(ctx.flags, 'prefix'),
      standalone: ctx.flags['standalone'] === true || undefined,
      module: ctx.flags['module'] === true || undefined,
      tags: flagString(ctx.flags, 'tags')
        ?.split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    }),
  );
  return 0;
}
