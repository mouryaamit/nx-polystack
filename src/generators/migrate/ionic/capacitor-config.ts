import { Tree } from '@nx/devkit';

import { parseJsonStrict } from '../source';

export const CAPACITOR_CONFIGS = [
  'capacitor.config.ts',
  'capacitor.config.js',
  'capacitor.config.json',
] as const;

export interface WebDirChange {
  /** The config file, relative to the app root. */
  file: string;
  /** The old value; undefined when it could not be read. */
  from?: string;
  to: string;
  /** Not rewritten: the user must set `webDir` by hand. */
  manual?: 'not-literal' | 'not-set';
}

/**
 * The text with comments and string contents blanked out (same length, newlines kept) and, for
 * each position, the object-literal brace depth.
 */
function scan(text: string): { code: string; depth: number[] } {
  const out = text.split('');
  const depth: number[] = new Array(text.length).fill(0);
  let d = 0;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      for (let k = i; k < stop; k++) depth[k] = d;
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      for (let k = i; k < stop; k++) depth[k] = d;
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let k = i + 1;
      while (k < text.length && text[k] !== c) k += text[k] === '\\' ? 2 : 1;
      for (let m = i; m <= k && m < text.length; m++) depth[m] = d;
      blank(i + 1, Math.min(k, text.length));
      i = k + 1;
      continue;
    }
    if (c === '{') d++;
    depth[i] = d;
    if (c === '}') d = Math.max(0, d - 1);
    i++;
  }
  return { code: out.join(''), depth };
}

/** An unquoted `webDir:` property key. */
const WEBDIR_KEY = /\bwebDir\s*:/g;
const LITERAL = /^\s*(['"])([^'"\n]*)\1/;

/**
 * Rewrites the top-level `webDir: '<literal>'` of a TS/JS config (comments and nested objects are
 * ignored). `not-set` when there is no top-level key, `not-literal` when its value is not a plain
 * string (or there are several).
 */
export function rewriteWebDirText(
  text: string,
  webDir: string,
): { text: string; from: string } | { manual: 'not-literal' | 'not-set' } {
  const { code, depth } = scan(text);
  const keys = [...code.matchAll(WEBDIR_KEY)].filter((m) => depth[m.index ?? 0] === 1);
  if (keys.length === 0) return { manual: 'not-set' };
  if (keys.length > 1) return { manual: 'not-literal' };
  const valueAt = (keys[0].index ?? 0) + keys[0][0].length;
  const literal = LITERAL.exec(text.slice(valueAt));
  if (!literal) return { manual: 'not-literal' };
  const [whole, quote, from] = literal;
  const start = valueAt + whole.length - from.length - 2;
  return {
    text: `${text.slice(0, start)}${quote}${webDir}${quote}${text.slice(valueAt + whole.length)}`,
    from,
  };
}

/** Points the app's Capacitor config at `webDir`; undefined when the app has no config. */
export function rewriteCapacitorConfig(
  tree: Tree,
  appRoot: string,
  webDir: string,
): WebDirChange | undefined {
  const file = CAPACITOR_CONFIGS.find((f) => tree.exists(`${appRoot}/${f}`));
  if (!file) return undefined;
  const at = `${appRoot}/${file}`;
  const text = tree.read(at, 'utf8') ?? '';
  if (file === 'capacitor.config.json') {
    const json = parseJsonStrict<Record<string, unknown>>(text, at);
    const from = typeof json['webDir'] === 'string' ? (json['webDir'] as string) : undefined;
    json['webDir'] = webDir;
    tree.write(at, JSON.stringify(json, null, 2) + '\n');
    return { file, from, to: webDir };
  }
  const rewritten = rewriteWebDirText(text, webDir);
  if ('manual' in rewritten) return { file, to: webDir, manual: rewritten.manual };
  if (rewritten.from !== webDir) tree.write(at, rewritten.text);
  return { file, from: rewritten.from, to: webDir };
}
