import {
  closingBracket,
  environmentObjectStart,
  firstCodeIndex,
  scanObjectLiteral,
} from '../env-encryption/env-file';

export interface EmptiedEnvironment {
  text: string;
  /** Key paths (a.b.c) whose value was not a literal and became `''`. */
  expressions: string[];
  /** Spread and shorthand entries, left as written. */
  unkeyed: string[];
}

const NUMBER = /^-?(0[xXbBoO][\da-fA-F_]+|\d[\d_.eE+-]*)/;

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Top-level keys whose value is kept: they say which build this is, not where it points. */
export const KEPT_ENV_KEYS = ['production'];

/**
 * The env file with every value of the `environment` object emptied by type (except the
 * top-level `keep` keys, `production` by default): strings `''` (the
 * quote kept), numbers `0`, booleans `false`, arrays `[]`, objects emptied the same way (nested);
 * `null` and `undefined` stay. A value that is not a literal (a call, a variable, a template with
 * `${…}`, `ENC(…)`) becomes `''` and is listed. Keys, comments and the rest of the file stay.
 */
export function emptyEnvironmentText(
  text: string,
  keep: readonly string[] = KEPT_ENV_KEYS,
): EmptiedEnvironment {
  const open = environmentObjectStart(text);
  if (open < 0) {
    throw new Error('no `export const environment = { … }` object found');
  }
  const edits: Edit[] = [];
  const expressions: string[] = [];
  const unkeyed: string[] = [];
  emptyObject(text, open, '', edits, expressions, unkeyed, new Set(keep));
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return { text: out, expressions, unkeyed };
}

function emptyObject(
  text: string,
  open: number,
  prefix: string,
  edits: Edit[],
  expressions: string[],
  unkeyed: string[],
  keep: ReadonlySet<string> = new Set(),
): void {
  const scan = scanObjectLiteral(text, open);
  unkeyed.push(...scan.unkeyed.map((u) => (prefix ? `${prefix}.${u}` : u)));
  for (const f of scan.fields) {
    const keyPath = prefix ? `${prefix}.${f.key}` : f.key;
    if (!prefix && keep.has(f.key)) continue;
    if (f.kind === 'string') {
      const quote = text[f.start];
      edits.push({ start: f.start, end: f.end, text: quote + quote });
      continue;
    }
    if (f.kind === 'expression') {
      edits.push({ start: f.start, end: f.end, text: "''" });
      expressions.push(keyPath);
      continue;
    }
    const at = f.start + firstCodeIndex(f.value);
    const c = text[at];
    if (c === '{') {
      emptyObject(text, at, keyPath, edits, expressions, unkeyed);
    } else if (c === '[') {
      const close = closingBracket(text, at);
      if (close > at) edits.push({ start: at, end: close + 1, text: '[]' });
    } else if (text.startsWith('true', at) || text.startsWith('false', at)) {
      const len = text.startsWith('true', at) ? 4 : 5;
      edits.push({ start: at, end: at + len, text: 'false' });
    } else {
      const m = NUMBER.exec(text.slice(at));
      if (m) edits.push({ start: at, end: at + m[0].length, text: '0' });
      // null / undefined stay.
    }
  }
}

/** A JSON value with every leaf emptied by type (strings '', numbers 0, booleans false, arrays []). */
export function emptyJson(value: unknown): unknown {
  if (typeof value === 'string') return '';
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, emptyJson(v)]));
  }
  return value;
}
