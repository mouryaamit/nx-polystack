import * as fs from 'fs';
import * as path from 'path';

import { GeneratorCallback, logger, Tree } from '@nx/devkit';

import { readPackageVersion, selfPackageRoot } from '../../cli/context';
import { refreshLlmBlocks, workspaceProjectNames } from '../../lib/utils/llm-block';

import {
  ADAPTER_IDS,
  allAdapters,
  chooseAdapter,
  detectAll,
  formatDetectionTable,
  parseMinConfidence,
} from './adapters';
import { loadExternalAdapters, parseNxJson } from './adapters/external';
import { scaffoldAdapter } from './adapters/scaffold';
import {
  Detection,
  isWorkspaceAdapter,
  MigrationContext,
  MigrationReportData,
  WorkspaceMigrationAdapter,
  WorkspaceMigrationContext,
} from './adapters/types';
import { DEFAULT_MAX_FILES } from './copy';
import { rewriteImports } from './imports/rewrite';
import { appRoot, assertDirOutsideProjects, kebabName, parseDir } from './names';
import { BatchDefaults, mergeEntryOptions, readBatchFile } from './batch';
import { renderReport } from './report';
import { buildManifest, manifestPath, writeManifest } from './rollback/manifest';
import { Originals, recordingTree } from './rollback/recording-tree';
import { formatRollbackSummary, rollbackMigration } from './rollback/rollback';
import { MigrateGeneratorSchema } from './schema.d';

export { NAME_RE } from './names';
import { NAME_RE } from './names';

export { kebabName } from './names';

/** The source directory, resolved against the current directory; must exist and not contain the workspace. */
export function resolveSource(tree: Tree, source: string | undefined): string {
  if (!source) {
    throw new Error(
      'migrate: --source is required (the path to the project to migrate), or ' +
        '--rollback=<name> to undo a migration.',
    );
  }
  const dir = path.resolve(process.cwd(), source);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`migrate: --source "${source}" does not exist (resolved to ${dir}).`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`migrate: --source "${source}" is not a directory.`);
  }
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  if (containsOrEquals(real(dir), real(tree.root))) {
    throw new Error(
      `migrate: --source "${source}" is the workspace or contains it. Point it at the project to migrate.`,
    );
  }
  return dir;
}

/** Whether `inner` is `outer` or inside it (works for "/" and drive roots, unlike a prefix test). */
export function containsOrEquals(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The workspace knip.json still has the flat apps/* entry glob (workspaces made before v0.16.0). */
/**
 * The workspace's external adapters (nx.json pstack.migrateAdapters), resolved from its root.
 * None are loaded when `--adapter` names a built-in one, so a broken entry cannot block it.
 */
function externalAdapters(tree: Tree, adapterId?: string) {
  if (adapterId !== undefined && ADAPTER_IDS.includes(adapterId)) return [];
  const nxJson = parseNxJson(tree.exists('nx.json') ? tree.read('nx.json', 'utf8') : undefined);
  return loadExternalAdapters(tree.root, nxJson);
}

function knipMissesNestedApps(tree: Tree): boolean {
  if (!tree.exists('knip.json')) return false;
  return (tree.read('knip.json', 'utf-8') ?? '').includes('"apps/*/src/main.ts"');
}

/** The report and manifest names belong to one migration: never overwrite another's. */
function assertNewMigrationName(tree: Tree, name: string): void {
  for (const p of [`docs/migrations/${name}.md`, manifestPath(name)]) {
    if (tree.exists(p)) {
      throw new Error(
        `migrate: "${p}" already exists (another migration uses the name "${name}"). ` +
          'Pass another --name.',
      );
    }
  }
}

/** docs/migrations/<name>.manifest.json for a finished run (what --rollback undoes). */
function recordManifest(
  tree: Tree,
  originals: Originals,
  name: string,
  adapterId: string,
  source: string,
  data: MigrationReportData,
): void {
  const plugin = readPackageVersion(path.join(selfPackageRoot(__dirname), 'package.json'));
  const ionicApps = (data.ionic ?? []).map((i) => path.posix.dirname(i.packagePath));
  writeManifest(
    tree,
    buildManifest(tree, originals, { name, adapter: adapterId, source, plugin, ionicApps }),
  );
}

async function rollback(tree: Tree, schema: MigrateGeneratorSchema): Promise<undefined> {
  const name = schema.rollback as string;
  if (schema.source) {
    throw new Error(
      'migrate: pass either --source (to migrate) or --rollback=<name> (to undo a migration), not both.',
    );
  }
  if (
    schema.adapter ||
    schema.name ||
    schema.projects ||
    schema.prefix ||
    schema.detect ||
    schema.noDeps ||
    schema.forceAngular ||
    schema.minConfidence !== undefined ||
    schema.dir !== undefined
  ) {
    throw new Error('migrate: --rollback takes only --force (and --dry-run).');
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      `migrate: --rollback="${name}" must be a migration name (kebab-case), as in ` +
        'docs/migrations/<name>.md.',
    );
  }
  const result = rollbackMigration(tree, name, !!schema.force);
  refreshLlmBlocks(tree);
  logger.info(formatRollbackSummary(result));
  return undefined;
}

export default async function migrateGenerator(
  tree: Tree,
  schema: MigrateGeneratorSchema,
): Promise<GeneratorCallback | undefined> {
  if (schema.newAdapter !== undefined) {
    // Defaults (rewriteImports, maxFiles) may be filled in by Nx; only real choices conflict.
    const set = (
      ['source', 'rollback', 'config', 'name', 'adapter', 'projects', 'prefix', 'dir'] as const
    ).filter((k) => schema[k] !== undefined);
    const on = (['detect', 'noDeps', 'force', 'forceAngular'] as const).filter((k) => schema[k]);
    const others: string[][] = [...set, ...on].map((k) => [k]);
    if (others.length > 0) {
      throw new Error(
        `migrate: --new-adapter only writes a starter adapter; it takes no other options ` +
          `(got ${others.map(([k]) => k).join(', ')}).`,
      );
    }
    scaffoldAdapter(tree, schema.newAdapter);
    return undefined;
  }
  if (schema.config !== undefined) return migrateBatch(tree, schema);
  if (schema.rollback !== undefined) return rollback(tree, schema);
  if (schema.force) {
    throw new Error(
      'migrate: --force is only for --rollback (--force-angular is the migrate option).',
    );
  }
  return (await migrateOne(tree, schema))?.installTask;
}

async function migrateBatch(
  tree: Tree,
  schema: MigrateGeneratorSchema,
): Promise<GeneratorCallback | undefined> {
  if (
    schema.source ||
    schema.rollback !== undefined ||
    schema.force ||
    schema.name ||
    schema.adapter ||
    schema.projects ||
    schema.prefix ||
    schema.noDeps ||
    schema.detect
  ) {
    throw new Error(
      'migrate: --config takes only --force-angular, --max-files, --min-confidence, --dir, ' +
        '--no-rewrite-imports and --dry-run.',
    );
  }
  parseDir(schema.dir);
  const file = path.resolve(process.cwd(), schema.config as string);
  // External adapters are loaded only when an entry names one: a broken list then cannot block
  // a batch of built-in adapters (entries without --adapter load them in migrateOne).
  let batch: ReturnType<typeof readBatchFile>;
  try {
    batch = readBatchFile(file, ADAPTER_IDS);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('"adapter" must be one of')) throw err;
    batch = readBatchFile(
      file,
      allAdapters(externalAdapters(tree)).map((a) => a.id),
    );
  }
  const { defaults, entries } = batch;
  const cli: BatchDefaults = {};
  if (schema.forceAngular !== undefined) cli.forceAngular = schema.forceAngular;
  if (schema.maxFiles !== undefined) cli.maxFiles = schema.maxFiles;
  if (schema.minConfidence !== undefined) cli.minConfidence = schema.minConfidence;
  if (schema.dir !== undefined) cli.dir = schema.dir;
  if (schema.rewriteImports !== undefined) cli.rewriteImports = schema.rewriteImports;

  const done: MigrateOutcome[] = [];
  for (const entry of entries) {
    try {
      const outcome = await migrateOne(tree, mergeEntryOptions(entry, defaults, cli));
      if (outcome) done.push(outcome);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err))
        .replace(/^migrate: /, '')
        // Earlier entries are in the tree; the batch as a whole still writes nothing.
        .replace(' Nothing was written.', '');
      throw new Error(`migrate --config: entry ${entry.index} (${entry.given}): ${message}`);
    }
  }
  logger.info(
    [
      `Migrated ${done.length} entries from ${schema.config}.`,
      'Undo, last first:',
      ...[...done].reverse().map((d) => `  pstack migrate --rollback=${d.name}`),
    ].join('\n'),
  );
  const tasks = done.filter((d) => d.installTask);
  if (tasks.length === 0) return undefined;
  return async () => {
    for (const d of tasks) {
      try {
        await (d.installTask as GeneratorCallback)();
      } catch (err) {
        throw new Error(
          `migrate --config: install for "${d.name}" failed (files are written; run npm install ` +
            `and check that entry): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
}

interface MigrateOutcome {
  name: string;
  installTask?: GeneratorCallback;
}

/** One migration (the --source path). Undefined for --detect. */
async function migrateOne(
  tree: Tree,
  schema: MigrateGeneratorSchema,
): Promise<MigrateOutcome | undefined> {
  const sourceDir = resolveSource(tree, schema.source);
  const maxFiles = schema.maxFiles ?? DEFAULT_MAX_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error(
      `migrate: --max-files must be a positive whole number (got ${schema.maxFiles}).`,
    );
  }

  const minConfidence = parseMinConfidence(schema.minConfidence);
  const dir = parseDir(schema.dir);

  if (schema.detect) {
    logger.info(
      `Detection for ${sourceDir}:\n\n${formatDetectionTable(
        detectAll(sourceDir, externalAdapters(tree)),
      )}`,
    );
    return undefined;
  }

  if (schema.adapter && schema.minConfidence !== undefined) {
    throw new Error(
      'migrate: --adapter skips detection, so --min-confidence has no effect; pass one of them.',
    );
  }
  const { adapter, detection, forced } = chooseAdapter(
    sourceDir,
    schema.adapter,
    minConfidence,
    externalAdapters(tree, schema.adapter),
  );
  const projects =
    typeof schema.projects === 'string'
      ? schema.projects
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : schema.projects;
  if (isWorkspaceAdapter(adapter)) {
    if (dir !== undefined && !schema.dirInherited) {
      throw new Error(
        `migrate: --dir is for single-app sources; the ${adapter.id} adapter keeps the source layout.`,
      );
    }
    return migrateWorkspace(
      tree,
      schema,
      adapter,
      detection,
      forced,
      sourceDir,
      maxFiles,
      projects,
    );
  }
  if ((projects && projects.length > 0) || schema.noDeps || schema.prefix) {
    throw new Error(
      `migrate: --projects, --no-deps and --prefix are for Nx workspace sources; the ` +
        `${adapter.id} adapter migrates one app.`,
    );
  }

  const suggested = adapter.defaultName(sourceDir);
  const name = schema.name ?? (suggested ? kebabName(suggested) : '');
  if (!name) {
    throw new Error('migrate: could not derive an app name from the source; pass --name=<app>.');
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      `migrate: --name="${name}" must be kebab-case (lowercase letters, digits and single hyphens, ` +
        'starting with a letter).',
    );
  }
  const projectRoot = appRoot(name, dir);
  if (dir) assertDirOutsideProjects(tree, dir);
  if (tree.exists(projectRoot)) {
    throw new Error(`migrate: "${projectRoot}" already exists. Pick another --name.`);
  }
  if (workspaceProjectNames(tree).includes(name)) {
    throw new Error(`migrate: a project named "${name}" already exists. Pick another --name.`);
  }
  assertNewMigrationName(tree, name);

  const ctx: MigrationContext = {
    sourceDir,
    name,
    projectRoot,
    forceAngular: !!schema.forceAngular,
    maxFiles,
    rewriteImports: schema.rewriteImports !== false,
  };
  const rec = recordingTree(tree);
  adapter.preflight?.(rec.tree, ctx);
  const data = adapter.migrate(rec.tree, ctx);
  if (ctx.rewriteImports) {
    data.imports = rewriteImports(rec.tree, { sourceDir, moves: data.moves ?? [] });
  }
  if (dir && knipMissesNestedApps(tree)) {
    data.notes.push(
      `knip.json lists \`apps/*/src/main.ts\` as an entry, which does not reach ${projectRoot}; ` +
        'change it to `apps/**/src/main.ts` so `npm run stale-code` does not report the app as unused.',
    );
  }

  const reportPath = `docs/migrations/${name}.md`;
  rec.tree.write(
    reportPath,
    renderReport({
      name,
      adapterId: adapter.id,
      adapterLabel: adapter.label,
      detection,
      forced,
      projectRoot,
      minConfidence: schema.minConfidence,
      source: schema.sourceLabel ?? (schema.source as string),
      data,
    }),
  );

  // Copied source files are not run through Prettier: they stay as the source had them.
  refreshLlmBlocks(rec.tree);
  recordManifest(
    tree,
    rec.originals,
    name,
    adapter.id,
    schema.sourceLabel ?? (schema.source as string),
    data,
  );
  logger.info(
    `Migrated ${sourceDir} into ${projectRoot} with the ${adapter.id} adapter. ` +
      `Report: ${reportPath}. Undo with: pstack migrate --rollback=${name}`,
  );
  return { name, installTask: data.installTask };
}

async function migrateWorkspace(
  tree: Tree,
  schema: MigrateGeneratorSchema,
  adapter: WorkspaceMigrationAdapter,
  detection: Detection,
  forced: boolean,
  sourceDir: string,
  maxFiles: number,
  projects: string[] | undefined,
): Promise<MigrateOutcome> {
  const suggested = adapter.defaultName(sourceDir);
  const name = schema.name ?? (suggested ? kebabName(suggested) : '');
  if (!name || !NAME_RE.test(name)) {
    throw new Error(
      `migrate: the report name "${name}" is not kebab-case; pass --name=<report-name>.`,
    );
  }
  if (schema.prefix !== undefined && !NAME_RE.test(schema.prefix)) {
    throw new Error(`migrate: --prefix="${schema.prefix}" must be kebab-case.`);
  }
  const reportPath = `docs/migrations/${name}.md`;
  assertNewMigrationName(tree, name);
  const ctx: WorkspaceMigrationContext = {
    sourceDir,
    projects,
    noDeps: !!schema.noDeps,
    prefix: schema.prefix ?? '',
    forceAngular: !!schema.forceAngular,
    maxFiles,
    rewriteImports: schema.rewriteImports !== false,
  };
  const rec = recordingTree(tree);
  adapter.preflight(rec.tree, ctx);
  const data = adapter.migrate(rec.tree, ctx);
  if (ctx.rewriteImports) {
    data.imports = rewriteImports(rec.tree, { sourceDir, moves: data.moves ?? [] });
  }
  rec.tree.write(
    reportPath,
    renderReport({
      name,
      adapterId: adapter.id,
      adapterLabel: adapter.label,
      detection,
      forced,
      minConfidence: schema.minConfidence,
      source: schema.sourceLabel ?? (schema.source as string),
      data,
    }),
  );
  refreshLlmBlocks(rec.tree);
  recordManifest(
    tree,
    rec.originals,
    name,
    adapter.id,
    schema.sourceLabel ?? (schema.source as string),
    data,
  );
  logger.info(
    `Imported ${data.projects.length} project(s) from ${sourceDir} with the ${adapter.id} ` +
      `adapter. Report: ${reportPath}. Undo with: pstack migrate --rollback=${name}`,
  );
  return { name, installTask: data.installTask };
}
