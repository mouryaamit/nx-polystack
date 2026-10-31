import * as fs from 'fs';
import * as path from 'path';

import { flagBoolean, flagString } from '../args';
import { findWorkspaceRoot } from '../context';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { parseMinConfidence } from '../../generators/migrate/adapters';
import { parseDir } from '../../generators/migrate/names';

import { requireWorkspace } from './app';

const EXAMPLE =
  'Examples: pstack migrate --source=../legacy-portal\n' +
  '          pstack migrate --source=../nx-repo --projects=portal\n' +
  '          pstack migrate --rollback=portal   (undo a migration)';

/**
 * --source relative to where pstack was run. Kept as given when that is the process cwd (so the
 * report shows it as typed); made absolute otherwise.
 */
function sourceArg(ctx: CommandContext, source: string): string {
  if (path.isAbsolute(source)) return source;
  return path.resolve(ctx.cwd) === path.resolve(process.cwd())
    ? source
    : path.resolve(ctx.cwd, source);
}

/** noDeps → no-deps, for messages. */
const kebabFlag = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** --no-rewrite-imports (or --rewrite-imports=false); undefined when neither is given. */
function rewriteImportsFlag(ctx: CommandContext): boolean | undefined {
  const off = ctx.flags['noRewriteImports'];
  const on = ctx.flags['rewriteImports'];
  if (off !== undefined && on !== undefined) {
    throw new CliError('Pass --rewrite-imports or --no-rewrite-imports, not both.');
  }
  if (off !== undefined) return !flagBoolean(ctx.flags, 'noRewriteImports');
  if (on !== undefined) return flagBoolean(ctx.flags, 'rewriteImports');
  return undefined;
}

export async function runMigrate(ctx: CommandContext): Promise<number> {
  const rewriteImports = rewriteImportsFlag(ctx);
  if (ctx.flags['dir'] === true) {
    throw new CliError('--dir needs a value: --dir=<folder>[/<folder>] (e.g. --dir=legacy).');
  }
  const dir = flagString(ctx.flags, 'dir');
  try {
    parseDir(dir);
  } catch (err) {
    throw new CliError((err as Error).message.replace(/^migrate: /, ''));
  }
  const minConfidenceFlag = flagString(ctx.flags, 'minConfidence');
  if (ctx.flags['minConfidence'] === true) {
    throw new CliError('--min-confidence needs a value: --min-confidence=<0.5..1>.');
  }
  let minConfidence: number | undefined;
  if (minConfidenceFlag !== undefined) {
    try {
      minConfidence = parseMinConfidence(minConfidenceFlag);
    } catch (err) {
      throw new CliError((err as Error).message.replace(/^migrate: /, ''));
    }
  }
  const newAdapter = ctx.flags['newAdapter'];
  if (newAdapter !== undefined && newAdapter !== false) {
    if (newAdapter === true || newAdapter === '') {
      throw new CliError('--new-adapter needs a value: --new-adapter=<id> (kebab-case).');
    }
    const root = requireWorkspace(ctx.cwd, 'migrate');
    const { default: migrateGenerator } = await import('../../generators/migrate/generator');
    await runInTree(root, ctx, (tree) =>
      migrateGenerator(tree, {
        newAdapter,
        // Passed only so the generator can refuse them with --new-adapter.
        source: flagString(ctx.flags, 'source'),
        config: flagString(ctx.flags, 'config'),
        rollback: flagString(ctx.flags, 'rollback'),
        name: flagString(ctx.flags, 'name'),
        adapter: flagString(ctx.flags, 'adapter'),
        projects: flagString(ctx.flags, 'projects'),
        prefix: flagString(ctx.flags, 'prefix'),
        dir: flagString(ctx.flags, 'dir'),
        detect: flagBoolean(ctx.flags, 'detect'),
        noDeps: flagBoolean(ctx.flags, 'noDeps'),
        force: flagBoolean(ctx.flags, 'force'),
        forceAngular: flagBoolean(ctx.flags, 'forceAngular'),
      }),
    );
    return 0;
  }
  const config = ctx.flags['config'];
  if (config !== undefined && config !== false) {
    if (config === true || config === '') {
      throw new CliError('--config needs a value: --config=<file> (a JSON batch file).');
    }
    const conflicting = [
      'source',
      'rollback',
      'force',
      'name',
      'adapter',
      'projects',
      'prefix',
      'noDeps',
      'detect',
    ].filter((k) => ctx.flags[k] !== undefined && ctx.flags[k] !== false);
    if (conflicting.length > 0) {
      throw new CliError(
        `migrate: --config takes only --force-angular, --max-files, --min-confidence, --dir, ` +
          `--no-rewrite-imports and --dry-run ` +
          `(got --${conflicting.map(kebabFlag).join(', --')}).`,
      );
    }
    const maxFilesFlag = flagString(ctx.flags, 'maxFiles');
    const maxFiles = maxFilesFlag === undefined ? undefined : Number(maxFilesFlag);
    if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1)) {
      throw new CliError(`--max-files must be a positive whole number (got "${maxFilesFlag}").`);
    }
    const root = requireWorkspace(ctx.cwd, 'migrate');
    const { default: migrateGenerator } = await import('../../generators/migrate/generator');
    await runInTree(root, ctx, (tree) =>
      migrateGenerator(tree, {
        config: path.resolve(ctx.cwd, config),
        forceAngular:
          ctx.flags['forceAngular'] === undefined
            ? undefined
            : flagBoolean(ctx.flags, 'forceAngular'),
        maxFiles,
        minConfidence,
        dir,
        rewriteImports,
        keepOldScripts: flagBoolean(ctx.flags, 'keepOldScripts'),
      }),
    );
    return 0;
  }

  const rollback = ctx.flags['rollback'];
  if (rollback !== undefined && rollback !== false) {
    if (rollback === true || rollback === '') {
      throw new CliError(
        '--rollback needs a value: --rollback=<name> (the migration name in docs/migrations).',
      );
    }
    if (flagString(ctx.flags, 'source')) {
      throw new CliError(
        '--rollback and --source cannot be used together: --source migrates, --rollback undoes.',
      );
    }
    const root = requireWorkspace(ctx.cwd, 'migrate');
    const { default: migrateGenerator } = await import('../../generators/migrate/generator');
    await runInTree(root, ctx, (tree) =>
      migrateGenerator(tree, {
        rollback,
        force: flagBoolean(ctx.flags, 'force'),
        // Passed only so the generator can refuse them with --rollback.
        name: flagString(ctx.flags, 'name'),
        adapter: flagString(ctx.flags, 'adapter') as 'angular-cli' | undefined,
        projects: flagString(ctx.flags, 'projects'),
        prefix: flagString(ctx.flags, 'prefix'),
        detect: flagBoolean(ctx.flags, 'detect'),
        noDeps: flagBoolean(ctx.flags, 'noDeps'),
        forceAngular: flagBoolean(ctx.flags, 'forceAngular'),
        minConfidence,
        dir,
      }),
    );
    return 0;
  }

  const given = flagString(ctx.flags, 'source');
  if (!given) {
    throw new CliError(`--source is required (the path to the project to migrate).\n\n${EXAMPLE}`);
  }
  const source = sourceArg(ctx, given);
  const adapter = flagString(ctx.flags, 'adapter');

  if (flagBoolean(ctx.flags, 'detect')) {
    // Read-only: no workspace needed.
    const { detectAll, formatDetectionTable, MIN_CONFIDENCE, recognisedUnsupported } = await import(
      '../../generators/migrate/adapters'
    );
    const sourceDir = path.resolve(ctx.cwd, given);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new CliError(`--source "${given}" is not a directory.`);
    }
    // Inside a workspace, its external adapters (nx.json pstack.migrateAdapters) take part too.
    const { loadExternalAdapters, parseNxJson } = await import(
      '../../generators/migrate/adapters/external'
    );
    const wsRoot = findWorkspaceRoot(ctx.cwd);
    let extra: Awaited<ReturnType<typeof loadExternalAdapters>> = [];
    if (wsRoot) {
      try {
        extra = loadExternalAdapters(
          wsRoot,
          parseNxJson(fs.readFileSync(path.join(wsRoot, 'nx.json'), 'utf8')),
        );
      } catch (err) {
        throw new CliError((err as Error).message.replace(/^migrate: /, ''));
      }
    }
    const rows = detectAll(sourceDir, extra);
    console.log(formatDetectionTable(rows));
    const best = rows[0];
    const minimum = minConfidence ?? MIN_CONFIDENCE;
    const threshold = minimum.toFixed(2);
    console.log(
      best && best.confidence >= minimum
        ? `\npstack migrate would use the ${best.adapter.id} adapter.`
        : `\nNo adapter reaches ${threshold}; pick one with --adapter=<id> to migrate anyway.`,
    );
    const recognised = recognisedUnsupported(sourceDir);
    if (recognised.length > 0) {
      console.log(`Recognised, but not supported yet: ${recognised.join('; ')}.`);
    }
    return 0;
  }

  for (const [flag, example] of [
    ['projects', '--projects=a,b'],
    ['prefix', '--prefix=<p>'],
  ]) {
    if (ctx.flags[flag] === true) {
      throw new CliError(`--${flag} needs a value: ${example} (with "=", no space).`);
    }
  }

  const maxFilesFlag = flagString(ctx.flags, 'maxFiles');
  const maxFiles = maxFilesFlag === undefined ? undefined : Number(maxFilesFlag);
  if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1)) {
    throw new CliError(`--max-files must be a positive whole number (got "${maxFilesFlag}").`);
  }

  const root = requireWorkspace(ctx.cwd, 'migrate');
  const { default: migrateGenerator } = await import('../../generators/migrate/generator');
  type Schema = Parameters<typeof migrateGenerator>[1];
  await runInTree(root, ctx, (tree) =>
    migrateGenerator(tree, {
      source,
      name: flagString(ctx.flags, 'name'),
      adapter: adapter as Schema['adapter'],
      forceAngular: flagBoolean(ctx.flags, 'forceAngular'),
      projects: flagString(ctx.flags, 'projects'),
      noDeps: flagBoolean(ctx.flags, 'noDeps'),
      prefix: flagString(ctx.flags, 'prefix'),
      maxFiles,
      minConfidence,
      dir,
      rewriteImports,
      keepOldScripts: flagBoolean(ctx.flags, 'keepOldScripts'),
      force: flagBoolean(ctx.flags, 'force'),
    }),
  );
  return 0;
}
