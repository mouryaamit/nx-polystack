import { createHash } from 'crypto';

import { parseJson, Tree } from '@nx/devkit';

import { LLM_END, LLM_START } from '../../../lib/utils/llm-block';

import type { Originals } from './recording-tree';

export const MIGRATIONS_DIR = 'docs/migrations';
export const reportPath = (name: string) => `${MIGRATIONS_DIR}/${name}.md`;
export const manifestPath = (name: string) => `${MIGRATIONS_DIR}/${name}.manifest.json`;
export const rollbackNotesPath = (name: string) => `${MIGRATIONS_DIR}/${name}.rollback.md`;

export type JsonKey = string[];
export type JsonChange =
  | { key: JsonKey; added: unknown }
  | { key: JsonKey; from: unknown; to: unknown }
  | { key: JsonKey; removed: unknown }
  /** Arrays of scalars: the elements the run added and removed (so later additions survive). */
  | { key: JsonKey; arrayAdded: Scalar[]; arrayRemoved: Scalar[] };

export type Scalar = string | number | boolean | null;

export interface CreatedEntry {
  path: string;
  sha256: string;
}
export interface JsonEntry {
  path: string;
  /** Content before the run: restored byte for byte when the file is unchanged since. */
  previous: string;
  encoding?: 'base64';
  /** Hash of the content the run left. */
  sha256: string;
  changes: JsonChange[];
}
export interface TextEntry {
  path: string;
  /** Content before the run (base64 when `encoding` says so). */
  previous: string;
  encoding?: 'base64';
  /** Hash of the content the run left; absent when the run deleted the file. */
  sha256?: string;
  deleted?: true;
}

export interface Manifest {
  version: 1;
  name: string;
  adapter: string;
  source: string;
  plugin: string;
  /** Ionic app folders (each has its own node_modules, not removed by a rollback). */
  ionicApps?: string[];
  created: CreatedEntry[];
  json: JsonEntry[];
  text: TextEntry[];
}

export interface ManifestMeta {
  name: string;
  adapter: string;
  source: string;
  plugin: string;
  ionicApps: string[];
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}

/** Key-level diff: object keys recurse (sorted); arrays and scalars compare whole. */
export function diffJson(before: unknown, after: unknown, key: JsonKey = []): JsonChange[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const out: JsonChange[] = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) {
      const sub = [...key, k];
      if (!has(before, k)) out.push({ key: sub, added: after[k] });
      else if (!has(after, k)) out.push({ key: sub, removed: before[k] });
      else out.push(...diffJson(before[k], after[k], sub));
    }
    return out;
  }
  if (deepEqual(before, after)) return [];
  if (isScalarArray(before) && isScalarArray(after)) {
    return [{ key, arrayAdded: minus(after, before), arrayRemoved: minus(before, after) }];
  }
  return [{ key, from: before, to: after }];
}

const isScalar = (v: unknown): v is Scalar =>
  v === null || ['string', 'number', 'boolean'].includes(typeof v);
export const isScalarArray = (v: unknown): v is Scalar[] => Array.isArray(v) && v.every(isScalar);

/** Elements of `a` not matched in `b`, counting duplicates. */
export function minus(a: Scalar[], b: Scalar[]): Scalar[] {
  const rest = [...b];
  const out: Scalar[] = [];
  for (const x of a) {
    const i = rest.indexOf(x);
    if (i >= 0) rest.splice(i, 1);
    else out.push(x);
  }
  return out;
}

/** Text between the nx-polystack markers is dropped: every run refreshes it. */
export function stripLlmBlock(text: string): string {
  const start = text.indexOf(LLM_START);
  const end = text.indexOf(LLM_END);
  if (start < 0 || end < start) return text;
  return text.slice(0, start + LLM_START.length) + text.slice(end);
}

const isUtf8 = (buf: Buffer) => Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);

/** sha256 of a file; a text file with nx-polystack markers is hashed without the managed block. */
export function contentHash(content: Buffer): string {
  const text = content.toString('utf8');
  const basis = isUtf8(content) && text.includes(LLM_START) ? stripLlmBlock(text) : content;
  return createHash('sha256').update(basis).digest('hex');
}

function parseJsonSafe(buf: Buffer): unknown | undefined {
  try {
    return parseJson(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

function previousOf(buf: Buffer): Pick<TextEntry, 'previous' | 'encoding'> {
  return isUtf8(buf)
    ? { previous: buf.toString('utf8') }
    : { previous: buf.toString('base64'), encoding: 'base64' };
}

/** What the run changed, from the recorded originals and the tree as the run left it. */
export function buildManifest(tree: Tree, originals: Originals, meta: ManifestMeta): Manifest {
  const created: CreatedEntry[] = [];
  const json: JsonEntry[] = [];
  const text: TextEntry[] = [];
  for (const p of [...originals.keys()].sort()) {
    const before = originals.get(p) ?? null;
    const after = tree.isFile(p) ? tree.read(p) : null;
    if (before === null) {
      if (after) created.push({ path: p, sha256: contentHash(after) });
      continue;
    }
    if (after === null) {
      text.push({ path: p, ...previousOf(before), deleted: true });
      continue;
    }
    if (before.equals(after)) continue;
    if (p.endsWith('.json')) {
      const b = parseJsonSafe(before);
      const a = parseJsonSafe(after);
      if (b !== undefined && a !== undefined) {
        const changes = diffJson(b, a);
        if (changes.length > 0) {
          json.push({ path: p, ...previousOf(before), sha256: contentHash(after), changes });
        }
        continue;
      }
    }
    text.push({ path: p, ...previousOf(before), sha256: contentHash(after) });
  }
  return {
    version: 1,
    name: meta.name,
    adapter: meta.adapter,
    source: meta.source,
    plugin: meta.plugin,
    ...(meta.ionicApps.length > 0 ? { ionicApps: [...meta.ionicApps].sort() } : {}),
    created,
    json,
    text,
  };
}

export function writeManifest(tree: Tree, manifest: Manifest): void {
  tree.write(manifestPath(manifest.name), JSON.stringify(manifest, null, 2) + '\n');
}

/** The manifest of migration `name`, or null when there is none. */
export function readManifest(tree: Tree, name: string): Manifest | null {
  const p = manifestPath(name);
  if (!tree.isFile(p)) return null;
  const value = parseJsonSafe(tree.read(p) as Buffer);
  if (!isPlainObject(value) || value['version'] !== 1) {
    throw new Error(`migrate: ${p} is not a version 1 migrate manifest.`);
  }
  return value as unknown as Manifest;
}
