import { flagBoolean, flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

const list = (v: string | undefined): string[] | undefined =>
  v === undefined
    ? undefined
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const EXAMPLE = 'pstack env --name=qa --app=portal --from=uat --api-url=https://qa.example.com/api';

export async function runEnv(ctx: CommandContext): Promise<number> {
  for (const f of ['name', 'app', 'from', 'apiUrl', 'baseHref', 'domains']) {
    if (ctx.flags[f] === true) {
      throw new CliError(`--${f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a value.`);
    }
  }
  const name = flagString(ctx.flags, 'name');
  if (!name) throw new CliError(`--name is required.\n\nExample: ${EXAMPLE}`);
  const projects = list(flagString(ctx.flags, 'app'));
  const all = ctx.flags['all'] !== undefined && flagBoolean(ctx.flags, 'all');
  if (all === (projects !== undefined && projects.length > 0)) {
    throw new CliError(
      `Name the apps with --app=<a,b> or pass --all (one of them).\n\nExample: ${EXAMPLE}`,
    );
  }
  const root = requireWorkspace(ctx.cwd, 'env');
  const { default: envGenerator } = await import('../../generators/env/generator');
  try {
    await runInTree(root, ctx, (tree) =>
      envGenerator(tree, {
        name,
        projects,
        all,
        from: flagString(ctx.flags, 'from'),
        apiUrl: flagString(ctx.flags, 'apiUrl'),
        production:
          ctx.flags['production'] === undefined ? undefined : flagBoolean(ctx.flags, 'production'),
        baseHref: flagString(ctx.flags, 'baseHref'),
        domains: list(flagString(ctx.flags, 'domains')),
      }),
    );
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError((err as Error).message.replace(/^env generator: /, ''));
  }
  return 0;
}
