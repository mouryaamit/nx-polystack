import * as fs from 'fs';
import * as path from 'path';

import { flagString } from '../args';
import { manifestRoot } from '../context';
import { MigrationsManifest, runMigrations, selectMigrations } from '../migrations';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';
import { normalizeVersion } from '../versions';

import { requireWorkspace } from './app';

/** Hidden: `pstack _migrate --from=X --to=Y`. Spawned by `pstack update` from the newly installed local plugin. */
export async function runInternalMigrate(ctx: CommandContext): Promise<number> {
  const fromFlag = flagString(ctx.flags, 'from');
  const toFlag = flagString(ctx.flags, 'to');
  if (!fromFlag || !toFlag) {
    throw new CliError('_migrate requires --from=<version> and --to=<version>.');
  }
  const from = normalizeVersion(fromFlag);
  const to = normalizeVersion(toFlag);
  const root = requireWorkspace(ctx.cwd, '_migrate');

  const dir = manifestRoot(ctx.selfRoot);
  const manifest: MigrationsManifest = JSON.parse(
    fs.readFileSync(path.join(dir, 'migrations.json'), 'utf8'),
  );
  const entries = selectMigrations(manifest, from, to);

  if (entries.length === 0) {
    console.log(`No migrations to run (v${from} → v${to}).`);
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
