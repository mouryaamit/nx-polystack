/**
 * @mouryaamit/nx-polystack/migrate — the adapter SDK.
 *
 * Write a :migrate adapter for a source shape nx-polystack does not know, list it in nx.json
 * (`"pstack": { "migrateAdapters": ["./tools/migrate/my.adapter.ts"] }`) and `pstack migrate`
 * uses it like a built-in one: detection, --adapter, --config, the report, import rewriting and
 * --rollback. The contract is versioned: an adapter declares `apiVersion: MIGRATE_API_VERSION`.
 */
import type {
  MigrationAdapter,
  WorkspaceMigrationAdapter,
} from './generators/migrate/adapters/types';
import type { MIGRATE_API_VERSION } from './generators/migrate/adapters/types';

export { MIGRATE_API_VERSION } from './generators/migrate/adapters/types';

// Contract
export type {
  AnyMigrationAdapter,
  DependencyClash,
  Detection,
  IonicReport,
  MigratedProjectRow,
  MigrationAdapter,
  MigrationContext,
  MigrationReportData,
  PackageFieldNote,
  TsPathClash,
  UnsupportedProjectRow,
  WorkspaceMigrationAdapter,
  WorkspaceMigrationContext,
  WorkspaceReportData,
} from './generators/migrate/adapters/types';
export { emptyReportData, recordCopy } from './generators/migrate/adapters/types';

// Copying the source (skip rules, secrets, .gitignore, --max-files)
export type { CopyOptions, CopyResult, SkipRules } from './generators/migrate/copy';
export { copyIntoTree, DEFAULT_MAX_FILES, isPossibleSecret } from './generators/migrate/copy';

// Dependencies into the root package.json
export type { DependencySkip, MergeInput } from './generators/migrate/dependencies';
export { mergeDependencies } from './generators/migrate/dependencies';
export type { SpecContext, SpecKind } from './generators/migrate/npm-deps';
export { classifyDependencySpec } from './generators/migrate/npm-deps';

// Reading the source (read only)
export type { PackageJson } from './generators/migrate/source';
export {
  isSourceFile,
  readSourceJson,
  readSourcePackageJson,
  readSourceText,
  sourceDependency,
  sourceExists,
} from './generators/migrate/source';

// Names and paths
export { kebabName, upTo } from './generators/migrate/names';
export { setProjectTags } from './lib/utils/nx-targets';

/** A single-app or workspace adapter with the SDK version it was written for. */
export type ExternalMigrationAdapter =
  | (MigrationAdapter & { apiVersion: typeof MIGRATE_API_VERSION })
  | (WorkspaceMigrationAdapter & { apiVersion: typeof MIGRATE_API_VERSION });

/** Identity helper that type-checks an adapter (and documents the module's export). */
export function defineMigrationAdapter<T extends ExternalMigrationAdapter>(adapter: T): T {
  return adapter;
}
