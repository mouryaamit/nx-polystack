import { parseJson, Tree } from '@nx/devkit';

import {
  contentHash,
  deepEqual,
  isPlainObject,
  isScalarArray,
  minus,
  Scalar,
  JsonKey,
  manifestPath,
  MIGRATIONS_DIR,
  readManifest,
  reportPath,
  rollbackNotesPath,
  TextEntry,
} from './manifest';

export interface KeptItem {
  path: string;
  what: string;
}

export interface RollbackResult {
  name: string;
  /** Nothing was kept: the manifest is deleted too. */
  complete: boolean;
  removed: string[];
  restored: string[];
  /** JSON files that changed. */
  jsonFiles: string[];
  /** JSON keys removed, put back or reset (containers emptied on the way are not counted). */
  jsonReverted: number;
  /** Files the run created or changed that are no longer there. */
  gone: string[];
  kept: KeptItem[];
  ionicApps: string[];
}

interface Holder {
  doc: unknown;
}
interface JsonOutcome {
  reverted: number;
  kept: JsonKey[];
}

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function getAt(doc: unknown, key: JsonKey): { found: boolean; value?: unknown } {
  let cur = doc;
  for (const k of key) {
    if (!isPlainObject(cur) || !has(cur, k)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

/** Sets `key` (creating parent objects); false when a parent is not an object. */
function setAt(h: Holder, key: JsonKey, value: unknown): boolean {
  if (key.length === 0) {
    h.doc = clone(value);
    return true;
  }
  if (!isPlainObject(h.doc)) return false;
  let cur: Record<string, unknown> = h.doc;
  for (const k of key.slice(0, -1)) {
    if (!has(cur, k)) cur[k] = {};
    const next = cur[k];
    if (!isPlainObject(next)) return false;
    cur = next;
  }
  cur[key[key.length - 1]] = clone(value);
  return true;
}

function deleteAt(h: Holder, key: JsonKey): void {
  const parent = getAt(h.doc, key.slice(0, -1));
  if (parent.found && isPlainObject(parent.value)) delete parent.value[key[key.length - 1]];
}

/**
 * Removes what the run added. An added object is undone key by key, so keys added to it later
 * stay; it is removed when that leaves it empty.
 */
function revertAdded(h: Holder, key: JsonKey, added: unknown, force: boolean, o: JsonOutcome) {
  const cur = getAt(h.doc, key);
  if (!cur.found) return;
  if (isPlainObject(added) && isPlainObject(cur.value)) {
    for (const k of Object.keys(added).reverse()) {
      revertAdded(h, [...key, k], added[k], force, o);
    }
    if (Object.keys(cur.value).length === 0) deleteAt(h, key);
    return;
  }
  if (force || deepEqual(cur.value, added)) {
    deleteAt(h, key);
    o.reverted++;
  } else {
    o.kept.push(key);
  }
}

function revertChanged(
  h: Holder,
  key: JsonKey,
  from: unknown,
  to: unknown,
  force: boolean,
  o: JsonOutcome,
) {
  const cur = getAt(h.doc, key);
  if (cur.found && deepEqual(cur.value, from)) return;
  if ((force || (cur.found && deepEqual(cur.value, to))) && setAt(h, key, from)) o.reverted++;
  else o.kept.push(key);
}

function revertRemoved(h: Holder, key: JsonKey, removed: unknown, force: boolean, o: JsonOutcome) {
  const cur = getAt(h.doc, key);
  if (cur.found && deepEqual(cur.value, removed)) return;
  if ((force || !cur.found) && setAt(h, key, removed)) o.reverted++;
  else o.kept.push(key);
}

/** Takes out the elements the run added and puts back the ones it removed; later edits stay. */
function revertArray(
  h: Holder,
  key: JsonKey,
  added: Scalar[],
  removed: Scalar[],
  force: boolean,
  o: JsonOutcome,
) {
  const cur = getAt(h.doc, key);
  if (!cur.found || !isScalarArray(cur.value)) {
    o.kept.push(key); // replaced by something else since: left to the user, even with --force
    return;
  }
  const without = [...cur.value];
  for (const x of added) {
    const i = without.lastIndexOf(x);
    if (i >= 0) without.splice(i, 1);
  }
  const next = [...without, ...minus(removed, without)];
  if (!deepEqual(next, cur.value) && setAt(h, key, next)) o.reverted++;
}

const keyLabel = (key: JsonKey) => (key.length === 0 ? 'the whole file' : `\`${key.join('.')}\``);

function previousBytes(t: Pick<TextEntry, 'previous' | 'encoding'>): Buffer {
  return Buffer.from(t.previous, t.encoding === 'base64' ? 'base64' : 'utf8');
}

function missingManifest(tree: Tree, name: string): Error {
  const reports = tree
    .children(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.md') && !f.endsWith('.rollback.md'))
    .map((f) => f.slice(0, -'.md'.length))
    .sort();
  return new Error(
    `migrate: no manifest for "${name}" (${manifestPath(name)}): it was migrated before v0.13.0, ` +
      `or the name is wrong. Reports in ${MIGRATIONS_DIR}: ` +
      `${reports.length > 0 ? reports.join(', ') : 'none'}.`,
  );
}

/**
 * Undoes migration `name` on the tree: created files removed, JSON changes reverted key by key,
 * other changed files restored; anything changed since the run is kept unless `force`. The
 * report is deleted; the manifest too unless something was kept (so --force can finish later).
 */
export function rollbackMigration(tree: Tree, name: string, force: boolean): RollbackResult {
  const manifest = readManifest(tree, name);
  if (!manifest) throw missingManifest(tree, name);
  const report = reportPath(name);
  const r: RollbackResult = {
    name,
    complete: false,
    removed: [],
    restored: [],
    jsonFiles: [],
    jsonReverted: 0,
    gone: [],
    kept: [],
    ionicApps: manifest.ionicApps ?? [],
  };

  const ownsReport = manifest.created.some((c) => c.path === report);
  for (const c of manifest.created) {
    if (c.path === report) continue;
    if (!tree.isFile(c.path)) {
      r.gone.push(c.path);
    } else if (force || contentHash(tree.read(c.path) as Buffer) === c.sha256) {
      tree.delete(c.path);
      r.removed.push(c.path);
    } else {
      r.kept.push({ path: c.path, what: 'created by the migration, edited since' });
    }
  }

  for (const j of manifest.json) {
    if (!tree.isFile(j.path)) {
      r.gone.push(j.path);
      continue;
    }
    const bytes = tree.read(j.path) as Buffer;
    const previous = previousBytes(j);
    if (bytes.equals(previous)) continue; // restored by an earlier run
    if (contentHash(bytes) === j.sha256) {
      // Unchanged since the run: put the original bytes back (keeps comments and formatting).
      tree.write(j.path, previous);
      r.jsonFiles.push(j.path);
      r.jsonReverted += j.changes.length;
      continue;
    }
    const raw = bytes.toString('utf8');
    let original: unknown;
    try {
      original = parseJson(raw);
    } catch {
      r.kept.push({ path: j.path, what: 'no longer valid JSON; not changed' });
      continue;
    }
    const h: Holder = { doc: parseJson(raw) };
    const o: JsonOutcome = { reverted: 0, kept: [] };
    for (const ch of [...j.changes].reverse()) {
      if ('added' in ch) revertAdded(h, ch.key, ch.added, force, o);
      else if ('removed' in ch) revertRemoved(h, ch.key, ch.removed, force, o);
      else if ('arrayAdded' in ch) revertArray(h, ch.key, ch.arrayAdded, ch.arrayRemoved, force, o);
      else revertChanged(h, ch.key, ch.from, ch.to, force, o);
    }
    if (!deepEqual(original, h.doc)) {
      tree.write(j.path, JSON.stringify(h.doc, null, 2) + '\n');
      r.jsonFiles.push(j.path);
    }
    r.jsonReverted += o.reverted;
    for (const key of o.kept.reverse()) {
      r.kept.push({ path: j.path, what: `${keyLabel(key)} changed since the migration` });
    }
  }

  for (const t of manifest.text) {
    const previous = previousBytes(t);
    const exists = tree.isFile(t.path);
    const current = exists ? (tree.read(t.path) as Buffer) : null;
    if (current && current.equals(previous)) continue; // restored by an earlier run
    const clean = t.deleted ? !exists : !!current && contentHash(current) === t.sha256;
    if (clean || force) {
      tree.write(t.path, previous);
      r.restored.push(t.path);
    } else {
      r.kept.push({
        path: t.path,
        what: t.deleted
          ? 'deleted by the migration, created again since'
          : exists
          ? 'changed by the migration, edited since'
          : 'changed by the migration, deleted since',
      });
    }
  }

  if (ownsReport && tree.exists(report)) tree.delete(report);
  r.complete = r.kept.length === 0;
  if (r.complete) {
    tree.delete(manifestPath(name));
    if (tree.exists(rollbackNotesPath(name))) tree.delete(rollbackNotesPath(name));
  } else {
    tree.write(rollbackNotesPath(name), renderRollbackNotes(r));
  }
  return r;
}

/** docs/migrations/<name>.rollback.md: what a rollback kept. */
export function renderRollbackNotes(r: RollbackResult): string {
  return [
    `# Rollback: ${r.name}`,
    '',
    `\`pstack migrate --rollback=${r.name}\` kept these because they changed after the migration:`,
    '',
    ...r.kept.map((k) => `- \`${k.path}\`: ${k.what}`),
    '',
    'Review them and remove or restore them yourself, or run ' +
      `\`pstack migrate --rollback=${r.name} --force\` to remove or restore them too. ` +
      `${manifestPath(r.name)} is kept until then.`,
    '',
  ].join('\n');
}

export function formatRollbackSummary(r: RollbackResult): string {
  const lines = [
    `Rolled back migration "${r.name}":`,
    `- ${r.removed.length} file(s) removed`,
    `- ${r.restored.length} file(s) restored`,
    `- ${r.jsonReverted} JSON setting(s) reverted in ${r.jsonFiles.length} file(s)`,
  ];
  if (r.gone.length > 0) lines.push(`- ${r.gone.length} file(s) already gone`);
  if (r.kept.length > 0) {
    lines.push(`Kept because they changed after the migration (${r.kept.length}):`);
    lines.push(...r.kept.map((k) => `- ${k.path}: ${k.what.replace(/`/g, '')}`));
    lines.push(
      `Listed in ${rollbackNotesPath(r.name)}. To remove or restore them too: ` +
        `pstack migrate --rollback=${r.name} --force`,
    );
  }
  lines.push('Run `npm install` to update node_modules.');
  for (const app of r.ionicApps) {
    lines.push(
      `${app}/node_modules and ${app}/package-lock.json (from its own npm install) are not removed.`,
    );
  }
  return lines.join('\n');
}
