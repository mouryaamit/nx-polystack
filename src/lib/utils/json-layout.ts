import * as fs from 'fs';
import * as path from 'path';

/** A jsonc-parser syntax tree node. */
export interface JsonNode {
  type: 'object' | 'array' | 'property' | 'string' | 'number' | 'boolean' | 'null';
  offset: number;
  length: number;
  parent?: JsonNode;
  children?: JsonNode[];
  value?: unknown;
}

/** The part of jsonc-parser used here (it ships with every nx 17-22). */
export interface JsoncParser {
  parse(text: string, errors?: unknown[], options?: { allowTrailingComma?: boolean }): unknown;
  parseTree(text: string): JsonNode | undefined;
  findNodeAtLocation(root: JsonNode, path: (string | number)[]): JsonNode | undefined;
}

/** jsonc-parser from the workspace's (or else the plugin's) nx install, or null. */
export function loadJsonc(workspaceRoot: string): JsoncParser | null {
  for (const from of [workspaceRoot, __dirname]) {
    try {
      const nxPkg = require.resolve('nx/package.json', { paths: [from] });
      const resolved = require.resolve('jsonc-parser', { paths: [path.dirname(nxPkg)] });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(resolved) as JsoncParser;
    } catch {
      // try the next install
    }
  }
  return null;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (v: unknown): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return a === b;
}

/** One-line JSON with a space after `:` and `,` (`{ "a": [1, 2] }`). */
function inline(value: unknown): string {
  if (Array.isArray(value)) return value.length ? `[${value.map(inline).join(', ')}]` : '[]';
  if (isObject(value)) {
    const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`);
    return entries.length ? `{ ${entries.join(', ')} }` : '{}';
  }
  return JSON.stringify(value);
}

/** The indentation of the line `offset` is on. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? '';
}

function tabOf(text: string): string {
  const m = /\n([ \t]+)["}\]]/.exec(text);
  return m ? m[1] : '  ';
}

/**
 * `before` changed into the value of `after`, as the smallest text edits on `before`: unchanged
 * entries keep their lines (one-line objects stay one line), removed keys go with their line,
 * added keys go after the key they follow in `after`, written in the style of their neighbours.
 * Null when either side does not parse or the result does not equal `after` (the caller then
 * keeps `after` as written).
 */
export function keepJsonLayout(jsonc: JsoncParser, before: string, after: string): string | null {
  const errors: unknown[] = [];
  const oldValue = jsonc.parse(before, errors, { allowTrailingComma: true });
  const newValue = jsonc.parse(after, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isObject(oldValue) || !isObject(newValue)) return null;
  if (sameJson(oldValue, newValue)) return before;

  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const tab = tabOf(before);
  let text = before;
  const splice = (offset: number, length: number, content: string) => {
    text = text.slice(0, offset) + content + text.slice(offset + length);
  };
  const block = (value: unknown, indent: string) =>
    JSON.stringify(value, null, tab)
      .split('\n')
      .join(eol + indent);
  const node = (at: (string | number)[]) => {
    const root = jsonc.parseTree(text);
    return root ? (at.length ? jsonc.findNodeAtLocation(root, at) : root) : undefined;
  };

  const replace = (at: (string | number)[], value: unknown): boolean => {
    const n = node(at);
    if (!n) return false;
    const old = text.slice(n.offset, n.offset + n.length);
    const content = old.includes('\n') ? block(value, lineIndent(text, n.offset)) : inline(value);
    splice(n.offset, n.length, content);
    return true;
  };
  // A property or element goes with the comma before it (or after it, when it is the first).
  const remove = (at: (string | number)[]): boolean => {
    const value = node(at);
    const item = value?.parent?.type === 'property' ? value.parent : value;
    const siblings = item?.parent?.children;
    if (!item || !siblings) return false;
    const i = siblings.indexOf(item);
    if (siblings.length === 1) {
      const p = item.parent as JsonNode;
      splice(p.offset, p.length, p.type === 'array' ? '[]' : '{}');
    } else if (i > 0) {
      const prev = siblings[i - 1];
      splice(
        prev.offset + prev.length,
        item.offset + item.length - (prev.offset + prev.length),
        '',
      );
    } else {
      splice(item.offset, siblings[1].offset - item.offset, '');
    }
    return true;
  };
  const insert = (
    parentAt: (string | number)[],
    key: string,
    value: unknown,
    order: string[],
  ): boolean => {
    const parent = node(parentAt);
    if (!parent || parent.type !== 'object') return false;
    const props = parent.children ?? [];
    const one = !text.slice(parent.offset, parent.offset + parent.length).includes('\n');
    const keyOf = (p: JsonNode) => p.children?.[0]?.value;
    let anchor: JsonNode | undefined;
    const names = props.map((p) => String(keyOf(p)));
    const sorted =
      names.length > 1 && names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0);
    if (sorted) {
      // A sorted object (dependencies) stays sorted: after the last key that sorts before it.
      for (const p of props) if (String(keyOf(p)).localeCompare(key) < 0) anchor = p;
    } else {
      for (let i = order.indexOf(key) - 1; i >= 0 && !anchor; i--) {
        anchor = props.find((p) => keyOf(p) === order[i]);
      }
    }
    const name = JSON.stringify(key);
    if (props.length === 0) {
      splice(parent.offset, parent.length, inline({ [key]: value }));
    } else if (anchor) {
      const end = anchor.offset + anchor.length;
      const indent = lineIndent(text, anchor.offset);
      splice(
        end,
        0,
        one ? `, ${name}: ${inline(value)}` : `,${eol}${indent}${name}: ${block(value, indent)}`,
      );
    } else {
      const first = props[0];
      const indent = lineIndent(text, first.offset);
      splice(
        first.offset,
        0,
        one ? `${name}: ${inline(value)}, ` : `${name}: ${block(value, indent)},${eol}${indent}`,
      );
    }
    return true;
  };

  // Same length: element by element. Entries only taken out: remove them. Else the whole array.
  const walkArray = (at: (string | number)[], o: Json[], n: Json[]): boolean => {
    if (o.length === n.length) {
      return o.every((ov, i) => {
        const nv = n[i];
        if (sameJson(ov, nv)) return true;
        if (isObject(ov) && isObject(nv)) return walk([...at, i], ov, nv);
        return replace([...at, i], nv);
      });
    }
    const kept: number[] = [];
    let j = 0;
    for (let i = 0; i < o.length && j < n.length; i++) if (sameJson(o[i], n[j])) kept.push(i), j++;
    if (j === n.length && n.length < o.length) {
      for (let i = o.length - 1; i >= 0; i--)
        if (!kept.includes(i) && !remove([...at, i])) return false;
      return true;
    }
    return replace(at, n);
  };

  const walk = (
    at: (string | number)[],
    o: Record<string, Json>,
    n: Record<string, Json>,
  ): boolean => {
    for (const key of Object.keys(o)) if (!(key in n) && !remove([...at, key])) return false;
    const order = Object.keys(n);
    for (const key of order) {
      const ov = o[key];
      const nv = n[key];
      if (!(key in o)) {
        if (!insert(at, key, nv, order)) return false;
      } else if (isObject(ov) && isObject(nv)) {
        if (!walk([...at, key], ov, nv)) return false;
      } else if (Array.isArray(ov) && Array.isArray(nv)) {
        if (!sameJson(ov, nv) && !walkArray([...at, key], ov, nv)) return false;
      } else if (!sameJson(ov, nv) && !replace([...at, key], nv)) return false;
    }
    return true;
  };
  if (!walk([], oldValue, newValue)) return null;

  const check = jsonc.parse(text, [], { allowTrailingComma: true });
  return sameJson(check, newValue) ? text : null;
}

/**
 * Snapshot of JSON config files (package.json, nx.json, project.json, tsconfig*.json,
 * .eslintrc.json) under `root`, outside node_modules, dist and dot folders.
 */
export function snapshotJsonConfigs(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const wanted = /^(package|nx|project)\.json$|^tsconfig.*\.json$|^\.eslintrc\.json$/;
  const skip = new Set(['node_modules', 'dist', 'tmp', 'coverage']);
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6 && !skip.has(e.name) && !e.name.startsWith('.')) visit(p, depth + 1);
      } else if (e.isFile() && wanted.test(e.name)) {
        files.set(p, fs.readFileSync(p, 'utf8'));
      }
    }
  };
  visit(root, 0);
  return files;
}

/**
 * Puts the layout of every snapshotted file that changed back, keeping only the value changes.
 * Returns the workspace-relative files restored.
 */
export function restoreJsonLayouts(
  root: string,
  snapshot: Map<string, string>,
  jsonc: JsoncParser,
): string[] {
  const restored: string[] = [];
  for (const [file, before] of snapshot) {
    let after: string;
    try {
      after = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (after === before) continue;
    const kept = keepJsonLayout(jsonc, before, after);
    if (kept !== null && kept !== after) {
      fs.writeFileSync(file, kept);
      restored.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  return restored.sort();
}
