import { formatFiles, GeneratorCallback, Tree, writeJson } from '@nx/devkit';

import { refreshLlmBlocks } from '../../lib/utils/llm-block';
import { addTypecheckTarget } from '../../lib/utils/quality';
import { addTsPath } from '../../lib/utils/ts-paths';

import { normalizeOptions } from './lib-utils';
import { LibGeneratorSchema } from './schema.d';
import { LIB_TYPES, PENDING_LIB_TYPES, PLANNED_LIB_TYPES } from './types';

export default async function libGenerator(
  tree: Tree,
  schema: LibGeneratorSchema,
): Promise<GeneratorCallback | undefined> {
  const spec = resolveType(schema.type);
  const o = normalizeOptions(tree, schema, spec);

  const task = spec.generate(tree, o);
  // tsc --noEmit over the lib's tsconfig.lib.json (libs without one get no target).
  addTypecheckTarget(tree, o.projectRoot);

  if (spec.tsPath) {
    if (!tree.exists('tsconfig.base.json')) {
      writeJson(tree, 'tsconfig.base.json', { compilerOptions: { paths: {} } });
    }
    addTsPath(tree, o.importPath, `${o.projectRoot}/src/index.ts`);
  }

  await formatFiles(tree);
  spec.afterFormat?.(tree, o);
  // After formatting: Prettier must not touch the text around the block.
  refreshLlmBlocks(tree);
  return task;
}

function resolveType(type: LibGeneratorSchema['type']) {
  if (!type) {
    throw new Error(`lib generator: --type is required. Supported types: ${supported()}.`);
  }
  if ((type as string) === 'auth-interceptor') {
    throw new Error(
      'lib generator: --type=auth-interceptor was removed in 0.24.0. HTTP interceptors, token ' +
        'handling and payload encryption are project-specific: write them in the app or in an ' +
        `angular lib of the project. Supported types: ${supported()}.`,
    );
  }
  if (PLANNED_LIB_TYPES.includes(type)) {
    throw new Error(
      `lib generator: --type=${type} is planned for a later release (after native apps). ` +
        `Supported types: ${supported()}.`,
    );
  }
  if (PENDING_LIB_TYPES.includes(type)) {
    throw new Error(
      `lib generator: --type=${type} is not implemented yet. Supported types: ${supported()}.`,
    );
  }
  const spec = LIB_TYPES[type];
  if (!spec) {
    throw new Error(`lib generator: unknown --type="${type}". Supported types: ${supported()}.`);
  }
  return spec;
}

function supported(): string {
  return Object.keys(LIB_TYPES).join(', ');
}
