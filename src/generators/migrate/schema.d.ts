export interface MigrateGeneratorSchema {
  /** Path to the source repo root (absolute, or relative to the current directory). Read only. */
  source?: string;
  /**
   * App name (single-app sources) or report name (Nx sources), kebab-case. Default: Angular
   * project name / pubspec name / source package name, kebab-cased.
   */
  name?: string;
  /** Skip detection and use this adapter (a built-in id, or one listed in nx.json pstack.migrateAdapters). */
  adapter?: string;
  /** Print the detection table and exit without writing anything. */
  detect?: boolean;
  /** Fail when more files than this would be copied. Default 20000. */
  maxFiles?: number;
  /** Proceed when the workspace's and the source's Angular majors differ. */
  forceAngular?: boolean;
  /** Nx sources: project names to migrate (comma-separated string or list). Default: all supported. */
  projects?: string | string[];
  /** Nx sources: only the --projects named, not the libs they need. */
  noDeps?: boolean;
  /** Nx sources: rename migrated projects to <prefix>-<name>; paths and aliases are kept. */
  prefix?: string;
  /** Undo the migration recorded in docs/migrations/<name>.manifest.json (instead of --source). */
  rollback?: string;
  /** With rollback: also remove or restore what changed after the migration. */
  force?: boolean;
  /** Run the migrations listed in this JSON batch file (path from the current directory). */
  config?: string;
  /** Use the best adapter when it reaches this confidence (0.5–1, default 0.8). */
  minConfidence?: number;
  /** Single-app sources: put the app in apps/<dir>/<name> (kebab-case folders separated by "/"). */
  dir?: string;
  /** Write a starter adapter tools/migrate/<name>.adapter.ts and list it in nx.json (nothing else). */
  newAdapter?: string;
  /** Rewrite imports in the copied code after the move (default true; --no-rewrite-imports). */
  rewriteImports?: boolean;
  /** Copy scripts pstack replaces (EXIF stripping, type checking) instead of replacing them. */
  keepOldScripts?: boolean;
  /** Internal (--config): dir came from defaults or the command line, not the entry. */
  dirInherited?: boolean;
  /** Internal (--config): the source as written in the batch file, for the report and manifest. */
  sourceLabel?: string;
}
