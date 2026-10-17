import { Tree } from '@nx/devkit';

import { normalizeProviders, writeLlmBlocks } from '../../lib/utils/llm-block';

import { LlmGeneratorSchema } from './schema.d';

/**
 * Writes the managed nx-polystack block into the requested AI-assistant instruction files.
 * Does not run formatFiles: the block is already in Prettier's shape, and text outside it must
 * stay exactly as written.
 */
export default async function llmGenerator(tree: Tree, schema: LlmGeneratorSchema): Promise<void> {
  writeLlmBlocks(tree, normalizeProviders(schema.providers));
}
