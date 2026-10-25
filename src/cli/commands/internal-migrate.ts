import * as fs from 'fs';
import * as path from 'path';

import { flagString } from '../args';
import { manifestRoot } from '../context';
import {
  allMigrations,
  MigrationEntry,
  MigrationsManifest,
  namedMigrations,
  runMigrations,
  selectMigrations,
} from '../migrations';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';
import { normalizeVersion } from '../versions';

import { requireWorkspace } from './app';

/**
 * Hidden, spawned by `pstack update` from the workspace's installed plugin:
 * - `pstack _migrate --from=X --to=Y`: the migrations after X up to Y;
 * - `pstack _migrate --only=a,b`: those migrations, whatever their version (v1.8.6 dev, public 1.8.7);
 * - `pstack _migrate --list`: every migration with its version.
 */
export async function runInternalMigrate(ctx: CommandContext): Promise<number> {
  const dir = manifestRoot(ctx.selfRoot);
  const manifest: MigrationsManifest = JSON.parse(
    fs.readFileSync(path.join(dir, 'migrations.json'), 'utf8'),
  );
  if (ctx.flags['list']) {
    for (const e of allMigrations(manifest)) {
      console.log(`${e.name.padEnd(32)} ${e.version.padEnd(8)} ${e.description ?? ''}`.trimEnd());
    }
    return 0;
  }
  const only = flagString(ctx.flags, 'only');
  let entries: MigrationEntry[];
  let none: string;
  if (only !== undefined) {
    const names = only
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length === 0) throw new CliError('--only needs migration names.');
    try {
      entries = namedMigrations(manifest, names);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    none = 'No migrations to run.';
  } else {
    const fromFlag = flagString(ctx.flags, 'from');
    const toFlag = flagString(ctx.flags, 'to');
    if (!fromFlag || !toFlag) {
      throw new CliError(
        '_migrate requires --from=<version> and --to=<version>, or --only=<names>.',
      );
    }
    const from = normalizeVersion(fromFlag);
    const to = normalizeVersion(toFlag);
    entries = selectMigrations(manifest, from, to);
    none = `No migrations to run (v${from} → v${to}).`;
  }
  const root = requireWorkspace(ctx.cwd, '_migrate');

  if (entries.length === 0) {
    console.log(none);
    return 0;
  }

  const changed: string[] = [];
  const result = await runMigrations(entries, async (e) => {
    const [file, exportName] = e.implementation.split('#');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.resolve(dir, file));
    const fn = (exportName ? mod[exportName] : undefined) ?? mod.default ?? mod;
    if (typeof fn !== 'function') {
      throw new Error(`migration ${e.name}: ${e.implementation} does not export a function`);
    }
    const files = await runInTree(root, { ...ctx, quietWhenUnchanged: true }, (tree) =>
      fn(tree, {}),
    );
    if (files > 0) changed.push(e.name);
    const what = e.description ? ` — ${e.description}` : '';
    console.log(
      files > 0
        ? `✔ ${e.name} (${e.version})${what}`
        : `· ${e.name} (${e.version}): nothing to change in this workspace${what}`,
    );
  });

  if (result.failed) {
    console.error(`✖ ${result.failed.name}: ${result.failed.error}`);
    console.error(
      'Earlier migrations stay applied, and files written before the failure stay on disk; review with "git diff".' +
        ' If a package install failed, run "npm install" — package.json may already list the new packages.',
    );
    return 1;
  }
  const ran = result.applied.length;
  if (ctx.dryRun) {
    console.log(`\n${ran} migration(s) checked (dry run, nothing written).`);
    return 0;
  }
  console.log(
    changed.length > 0
      ? `\n${ran} migration(s) ran, ${changed.length} made changes. Review with "git diff".`
      : `\n${ran} migration(s) ran; none needed changes in this workspace.`,
  );
  return 0;
}
