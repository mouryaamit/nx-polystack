import { GeneratorCallback, Tree } from '@nx/devkit';

import type { CopyResult } from '../copy';
import type { ImportMove, ImportRewriteResult } from '../imports/rewrite';
import type { WebDirChange } from '../ionic/capacitor-config';

/**
 * Internal contract between the :migrate generator and one source shape (Angular CLI app,
 * Flutter app, …). Kept free of generator internals so it can be exported as a public adapter
 * SDK later.
 */

/** The version of the adapter contract (types and helpers in `@mouryaamit/nx-polystack/migrate`). */
export const MIGRATE_API_VERSION = 1 as const;

export interface Detection {
  /** 0–1. The generator uses the best adapter when it reaches MIN_CONFIDENCE. */
  confidence: number;
  /** Human-readable signals and disqualifiers behind the confidence. */
  reasons: string[];
}

export interface MigrationContext {
  /** Absolute path of the source repo root. Read only. */
  sourceDir: string;
  /** App (and Nx project) name. */
  name: string;
  /** Destination in the workspace: apps/<name>. */
  projectRoot: string;
  /** Proceed when the workspace and the source use different Angular majors. */
  forceAngular: boolean;
  /** Fail when more files than this would be copied. */
  maxFiles?: number;
  /** The generator rewrites imports after the copy (default true): leave those notes to it. */
  rewriteImports?: boolean;
}

export interface DependencyClash {
  name: string;
  workspace: string;
  source: string;
}

export interface PackageFieldNote {
  field: string;
  /** What happened to it, e.g. "not carried over". */
  handling: string;
  entries: [string, string][];
}

export interface TsPathClash {
  alias: string;
  workspace: string[];
  source: string[];
}

/** What applyIonicShape did to one Ionic app, for the report's "## Ionic" section. */
export interface IonicReport {
  project: string;
  /** The app's own package.json in the workspace, e.g. apps/field/package.json. */
  packagePath: string;
  /** @ionic/angular version in the source. */
  ionic?: string;
  /** @capacitor/core version in the source. */
  capacitor?: string;
  /** Capacitor major the workspace generates Ionic apps with (default 5). */
  workspaceCapacitor?: number;
  /** Packages written to apps/<app>/package.json, sorted. */
  nativePackages: string[];
  /** Native packages also kept at the root: the copied code imports them (the web build needs them). */
  alsoAtRoot: string[];
  /** Native packages of the source left to the other Ionic apps of the import. */
  otherApps: string[];
  webDir?: WebDirChange;
  /** 'android' / 'ios' folders that were copied. */
  platforms: string[];
  cordovaPlugins: string[];
  /** "name (executor)" of source targets that were dropped. */
  droppedTargets: string[];
  /** Old build outputPath when it was inside the app folder (e.g. apps/a/www). */
  outputPathMoved?: string;
}

/** What an adapter did, for docs/migrations/<name>.md. */
export interface MigrationReportData {
  /** An npm project: the report has dependency, tsconfig-path and npm-script sections. */
  npmProject: boolean;
  /** Files written under apps/<name> from the source. */
  copied: number;
  /** Source paths not copied (directories end with "/"), relative to the source root. */
  skipped: string[];
  /** Possible secrets that were not copied, relative to the source root. */
  secrets: string[];
  /** The source is a git work tree: only files git tracks or would track were considered. */
  gitListed: boolean;
  /** Not a git work tree, but the source's .gitignore files were honoured. */
  gitignoreUsed: boolean;
  dependenciesAdded: string[];
  dependencyClashes: DependencyClash[];
  tsPathsAdded: string[];
  tsPathClashes: TsPathClash[];
  /** Other source package.json fields to review (overrides, resolutions, …). */
  packageFields: PackageFieldNote[];
  /** Source package.json scripts, which are not carried over. */
  sourceScripts: Record<string, string>;
  /** Angular version notes (mismatch, packages to install by hand). */
  angularNotes: string[];
  /** Anything else the user should look at (paths left unchanged, path dependencies, …). */
  notes: string[];
  /** Checklist items between `npm install` and removing the old repo. */
  nextSteps: string[];
  /** Ionic apps that were reshaped (empty or undefined when none). */
  ionic?: IonicReport[];
  /** Copied folders (filled by recordCopy), for import rewriting. */
  moves?: ImportMove[];
  /** What import rewriting did (set by the generator). */
  imports?: ImportRewriteResult;
  /** Installs added packages; runs after the files are written. */
  installTask?: GeneratorCallback;
}

export interface MigrationAdapter {
  /** Single-app adapter (the default). */
  kind?: 'app';
  /** SDK version the adapter was written for; required for external adapters (MIGRATE_API_VERSION). */
  apiVersion?: number;
  id: string;
  /** Short description for the detection table and the report. */
  label: string;
  detect(sourceDir: string): Detection;
  /** App name the source suggests (before kebab-casing); undefined when it has none. */
  defaultName(sourceDir: string): string | undefined;
  /**
   * Checks that must pass before anything is written (e.g. Angular major mismatch). Throws with a
   * user-facing message.
   */
  preflight?(tree: Tree, ctx: MigrationContext): void;
  migrate(tree: Tree, ctx: MigrationContext): MigrationReportData;
}

export function emptyReportData(): MigrationReportData {
  return {
    npmProject: true,
    copied: 0,
    skipped: [],
    secrets: [],
    gitListed: false,
    gitignoreUsed: false,
    dependenciesAdded: [],
    dependencyClashes: [],
    tsPathsAdded: [],
    tsPathClashes: [],
    packageFields: [],
    sourceScripts: {},
    angularNotes: [],
    notes: [],
    nextSteps: [],
  };
}

/**
 * Adds one copy's results to the report data; `prefix` is the copied folder inside the source
 * ("" for its root). Called once per copied folder.
 */
export function recordCopy(data: MigrationReportData, copy: CopyResult, prefix: string): void {
  const withPrefix = (p: string) => (prefix ? `${prefix}/${p}` : p);
  data.copied += copy.copied.length;
  if (copy.from !== undefined && copy.to !== undefined) {
    data.moves = [...(data.moves ?? []), { from: copy.from, to: copy.to, files: copy.copied }];
  }
  data.skipped.push(...copy.skipped.map(withPrefix));
  data.secrets.push(...copy.secrets.map(withPrefix));
  data.gitListed = data.gitListed || copy.git;
  data.gitignoreUsed = data.gitignoreUsed || copy.gitignore;
  const needed = copy.secrets.filter((p) => NEEDED_SECRET_FILES.includes(p.split('/').pop() ?? ''));
  for (const p of needed) {
    data.notes.push(
      `\`${withPrefix(p)}\` was not copied (it holds project credentials), but the app needs it: ` +
        'add it by hand.',
    );
  }
  const npmrcNote =
    '`.npmrc` was not copied (it can hold registry tokens). If the app needs its registry ' +
    'settings, add them to the workspace root `.npmrc`.';
  if (
    copy.secrets.some((p) => p.split('/').pop() === '.npmrc') &&
    !data.notes.includes(npmrcNote)
  ) {
    data.notes.push(npmrcNote);
  }
}

const NEEDED_SECRET_FILES = ['google-services.json', 'GoogleService-Info.plist'];

/** Options of a run that imports several projects from a workspace source. */
export interface WorkspaceMigrationContext {
  /** Absolute path of the source repo root. Read only. */
  sourceDir: string;
  /** --projects; undefined (or empty) for every supported project. */
  projects?: string[];
  /** --no-deps: only the named projects, no closure. */
  noDeps: boolean;
  /** --prefix; '' for none. */
  prefix: string;
  forceAngular: boolean;
  maxFiles?: number;
  /** See MigrationContext. */
  rewriteImports?: boolean;
}

export interface MigratedProjectRow {
  /** Name in the workspace (with the prefix). */
  name: string;
  sourceName: string;
  kind: string;
  root: string;
  /** "selected" or "needed by a, b". */
  why: string;
}

export interface UnsupportedProjectRow {
  name: string;
  kind: string;
  root: string;
}

export interface WorkspaceReportData extends MigrationReportData {
  projects: MigratedProjectRow[];
  /** Source projects of kinds that cannot be migrated yet. */
  unsupported: UnsupportedProjectRow[];
  /** How projects were placed: at their source paths (Nx), or in apps/ and libs/ (default same). */
  layout?: 'same-paths' | 'apps-libs';
}

/** An adapter that imports several projects (an Nx workspace) in one run. */
export interface WorkspaceMigrationAdapter {
  kind: 'workspace';
  /** See MigrationAdapter.apiVersion. */
  apiVersion?: number;
  id: string;
  label: string;
  detect(sourceDir: string): Detection;
  /** Report name the source suggests (before kebab-casing). */
  defaultName(sourceDir: string): string | undefined;
  /** Every check that must pass before anything is written. Throws with a user-facing message. */
  preflight(tree: Tree, ctx: WorkspaceMigrationContext): void;
  migrate(tree: Tree, ctx: WorkspaceMigrationContext): WorkspaceReportData;
}

export type AnyMigrationAdapter = MigrationAdapter | WorkspaceMigrationAdapter;

export function isWorkspaceAdapter(a: AnyMigrationAdapter): a is WorkspaceMigrationAdapter {
  return (a as WorkspaceMigrationAdapter).kind === 'workspace';
}
