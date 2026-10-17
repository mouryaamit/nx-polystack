// Public API barrel for @mouryaamit/nx-polystack.
// Generators and executors are referenced via generators.json / executors.json.
// This barrel exports the helper utilities a consumer may import directly.

// Utils
export * from './lib/utils/ci-resolve';
export * from './lib/utils/npm-scripts';
export * from './lib/utils/ts-paths';
export * from './lib/utils/env-files';
export * from './lib/utils/nx-targets';
export * from './lib/utils/filesystem';

// Helpers (build pipeline)
export * from './lib/helpers/encrypt-env';
export * from './lib/helpers/inject-meta';
export * from './lib/helpers/inject-nonce';
export * from './lib/helpers/inject-sri';
export * from './lib/helpers/strip-exif';

// Executor schemas
export type { FlutterBuildExecutorSchema } from './executors/flutter-build/schema.d';
export type { FlutterExportExecutorSchema } from './executors/flutter-export/schema.d';
// Generator schemas
export type { AppGeneratorSchema } from './generators/app/schema.d';
export type { EnvGeneratorSchema } from './generators/env/schema.d';
export type { LlmGeneratorSchema } from './generators/llm/schema.d';
