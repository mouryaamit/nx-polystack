import { flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

export async function runLlm(ctx: CommandContext): Promise<number> {
  const root = requireWorkspace(ctx.cwd, 'llm');
  const { normalizeProviders } = await import('../../lib/utils/llm-block');
  let providers: string;
  try {
    providers = normalizeProviders(flagString(ctx.flags, 'providers')).join(',');
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  const { default: llmGenerator } = await import('../../generators/llm/generator');
  await runInTree(root, ctx, (tree) => llmGenerator(tree, { providers }));
  return 0;
}
