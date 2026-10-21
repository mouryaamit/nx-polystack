import { flagString } from '../args';
import { runInTree } from '../run-tree';
import { CommandContext } from '../types';

import { presetInfraFlags } from './infra';
import { angularMajorFlag } from './new';

export async function runPreset(ctx: CommandContext): Promise<number> {
  const angular = angularMajorFlag(ctx.flags);
  const infraOptions = await presetInfraFlags(ctx.flags);
  const { default: presetGenerator } = await import('../../generators/preset/generator');
  await runInTree(ctx.cwd, ctx, (tree) =>
    presetGenerator(tree, {
      npmScope: flagString(ctx.flags, 'npmScope') || 'mouryaamit',
      baseBranch: flagString(ctx.flags, 'baseBranch') || 'master',
      apps: flagString(ctx.flags, 'apps'),
      ...infraOptions,
      llm: flagString(ctx.flags, 'llm'),
      projectDescription: flagString(ctx.flags, 'projectDescription'),
      angular,
      skipFormat: !!ctx.flags['skipFormat'],
      skipInstall: !!ctx.flags['skipInstall'],
      pluginVersion: ctx.selfVersion,
    }),
  );
  return 0;
}
