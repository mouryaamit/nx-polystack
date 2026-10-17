import { flagBoolean, Flags, flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

/** A flag that must be given as --name=value when present. */
function valueFlag(flags: Flags, key: string, name: string): string | undefined {
  if (flags[key] === true) throw new CliError(`${name} needs a value, e.g. ${name}=<value>.`);
  return flagString(flags, key);
}

/** :infra options from CLI flags, validated (usage errors are CliErrors). */
export async function infraFlags(flags: Flags) {
  const schema = {
    with: valueFlag(flags, 'with', '--with'),
    ci: valueFlag(flags, 'ci', '--ci'),
    ciCache: flagBoolean(flags, 'ciCache'),
    flutter: valueFlag(flags, 'flutter', '--flutter'),
    upgradeSchedule: valueFlag(flags, 'upgradeSchedule', '--upgrade-schedule'),
    upgradeScope: valueFlag(flags, 'upgradeScope', '--upgrade-scope'),
    lintStaged: valueFlag(flags, 'lintStaged', '--lint-staged'),
  };
  const { normalizeInfraOptions } = await import('../../generators/infra/generator');
  try {
    normalizeInfraOptions(schema);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  return schema;
}

/**
 * :infra options for `pstack new` / `pstack preset`: --infra (bare or missing: all parts; none;
 * or a list) plus --ci, --ci-cache, --flutter, --upgrade-schedule and --upgrade-scope, validated.
 */
export async function presetInfraFlags(flags: Flags) {
  const raw = flags['infra'];
  const infra = typeof raw === 'string' ? raw : 'all';
  const { parseParts } = await import('../../generators/infra/options');
  try {
    parseParts(infra, '--infra');
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  const { ci, ciCache, flutter, upgradeSchedule, upgradeScope } = await infraFlags(flags);
  return { infra, ci, ciCache, flutter, upgradeSchedule, upgradeScope };
}

export async function runInfra(ctx: CommandContext): Promise<number> {
  const schema = await infraFlags(ctx.flags);
  const force = flagBoolean(ctx.flags, 'force');
  const root = requireWorkspace(ctx.cwd, 'infra');
  const { default: infraGenerator } = await import('../../generators/infra/generator');
  await runInTree(root, ctx, (tree) =>
    infraGenerator(tree, { ...schema, force, skipFormat: flagBoolean(ctx.flags, 'skipFormat') }),
  );
  return 0;
}
