import { parseDir } from '../../lib/utils/app-dir';
import { flagString } from '../args';
import { findWorkspaceRoot } from '../context';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

export function requireWorkspace(cwd: string, command: string): string {
  const root = findWorkspaceRoot(cwd);
  if (!root) {
    throw new CliError(
      'no nx.json found in this directory or any parent.\n' +
        `Run "pstack ${command}" inside an Nx workspace, or create one with "pstack new <dir>".`,
    );
  }
  return root;
}

export async function runApp(ctx: CommandContext): Promise<number> {
  const name = flagString(ctx.flags, 'name');
  const type = flagString(ctx.flags, 'type');
  if (!name) {
    throw new CliError('--name is required.\n\nExample: pstack app --type=angular --name=portal');
  }
  if (!type) {
    throw new CliError(
      '--type is required (angular | ionic | flutter).\n\nExample: pstack app --type=angular --name=portal',
    );
  }
  if (ctx.flags['dir'] === true) {
    throw new CliError('--dir needs a value: --dir=<folder>[/<folder>] (e.g. --dir=legacy).');
  }
  const dir = flagString(ctx.flags, 'dir');
  try {
    parseDir(dir, 'app');
  } catch (err) {
    throw new CliError((err as Error).message.replace(/^app: /, ''));
  }
  if (ctx.flags['baseHref'] === true) {
    throw new CliError('--base-href needs a value, e.g. --base-href=/portal/.');
  }
  const baseHref = flagString(ctx.flags, 'baseHref');
  if (baseHref !== undefined) {
    const { checkBaseHref } = await import('../../lib/utils/base-href');
    try {
      checkBaseHref(baseHref);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
  }
  if (ctx.flags['port'] === true) throw new CliError('--port needs a value, e.g. --port=4210.');
  let port: number | undefined;
  const portFlag = flagString(ctx.flags, 'port');
  if (portFlag !== undefined) {
    const { portProblem } = await import('../../lib/utils/serve-port');
    port = /^\d+$/.test(portFlag) ? Number(portFlag) : NaN;
    const problem = portProblem(port);
    if (problem) throw new CliError(problem.replace(/\(got NaN\)/, `(got ${portFlag})`) + '.');
  }
  const envLayout = flagString(ctx.flags, 'envLayout');
  if (
    ctx.flags['envLayout'] === true ||
    (envLayout !== undefined && !['default', 'per-env'].includes(envLayout))
  ) {
    throw new CliError('--env-layout must be default or per-env.');
  }
  if (envLayout !== undefined && type === 'flutter') {
    throw new CliError('--env-layout is for Angular and Ionic apps (Flutter uses env/<env>.json).');
  }
  const root = requireWorkspace(ctx.cwd, 'app');
  const { default: appGenerator } = await import('../../generators/app/generator');
  await runInTree(root, ctx, (tree) =>
    appGenerator(tree, {
      name,
      type: type as 'angular' | 'ionic' | 'flutter',
      dir,
      tags: flagString(ctx.flags, 'tags')?.split(','),
      cspConnectSrc: flagString(ctx.flags, 'cspConnectSrc'),
      appId: flagString(ctx.flags, 'appId'),
      baseHref,
      port,
      envLayout: envLayout as 'default' | 'per-env' | undefined,
    }),
  );
  return 0;
}
