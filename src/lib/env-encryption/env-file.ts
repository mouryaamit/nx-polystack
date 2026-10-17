/**
 * A small scanner for Angular environment files (`export const environment = { … };`): the
 * top-level fields of the first object literal assigned to `environment`, and every quoted string
 * in the file. Comments, template literals and regular expression literals are skipped, never
 * rewritten.
 */

export type FieldKind = 'string' | 'other-literal' | 'expression';

export interface EnvField {
  key: string;
  kind: FieldKind;
  /** Raw value text (trimmed, comments kept). */
  value: string;
  /** For `string`: the content between the quotes (escapes kept). */
  text?: string;
  /** Offsets of the value in the file; for `string`, of the string literal only (text[start] is its quote). */
  start: number;
  end: number;
}

export interface EnvironmentScan {
  /** An `environment = { … }` object literal was found. */
  found: boolean;
  fields: EnvField[];
  /** Entries without a plain `key:` (shorthand, spread, computed keys), as written. */
  unkeyed: string[];
}

export interface QuotedString {
  /** Offset of the opening quote. */
  start: number;
  /** Offset after the closing quote. */
  end: number;
  quote: "'" | '"';
  /** Raw content between the quotes (escapes kept). */
  content: string;
}

/** Characters after which a `/` starts a regular expression literal rather than a division. */
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);

function previousCodeChar(text: string, i: number): string {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  return j >= 0 ? text[j] : '';
}

/** Index after a regex literal starting at `i` (the opening `/`). */
function endOfRegex(text: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      j++;
    } else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let k = j + 1;
      while (k < text.length && /[a-z]/i.test(text[k])) k++;
      return k;
    } else if (c === '\n') return j;
  }
  return text.length;
}

/** Index after a comment, string or regex literal starting at `i`, or -1 when `i` starts none. */
function skipNonCode(text: string, i: number): number {
  const c = text[i];
  const n = text[i + 1];
  if (c === '/' && n === '/') {
    const e = text.indexOf('\n', i);
    return e < 0 ? text.length : e;
  }
  if (c === '/' && n === '*') {
    const e = text.indexOf('*/', i + 2);
    return e < 0 ? text.length : e + 2;
  }
  if (c === '/' && REGEX_PRECEDERS.has(previousCodeChar(text, i))) return endOfRegex(text, i);
  if (c === "'" || c === '"' || c === '`') return endOfString(text, i);
  return -1;
}

/** Index after the string literal (or template literal) opening at `i`. */
function endOfString(text: string, i: number): number {
  const q = text[i];
  let depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (q === '`') {
      if (depth === 0 && c === '`') return j + 1;
      if (c === '$' && text[j + 1] === '{') {
        depth++;
        j++;
      } else if (c === '}' && depth > 0) depth--;
      continue;
    }
    if (c === q || c === '\n') return j + 1;
  }
  return text.length;
}

/** `text` with comments removed (strings and regexes kept). */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const s = skipNonCode(text, i);
    if (s < 0) {
      out += text[i++];
      continue;
    }
    const isComment = text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*');
    out += isComment ? ' ' : text.slice(i, s);
    i = s;
  }
  return out;
}

/** Every single- or double-quoted string outside comments (template literals excluded). */
export function quotedStrings(text: string): QuotedString[] {
  const out: QuotedString[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const skip = skipNonCode(text, i);
    if (skip < 0) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      out.push({ start: i, end: skip, quote: c, content: text.slice(i + 1, skip - 1) });
    }
    i = skip;
  }
  return out;
}

/** Offset of the `{` of the object assigned to `environment`, or -1. */
export function environmentObjectStart(text: string): number {
  const re = /\benvironment\b\s*(?::[^=]*)?=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // Skip matches inside comments or strings.
    let i = 0;
    let inside = false;
    while (i < m.index) {
      const s = skipNonCode(text, i);
      if (s < 0) {
        i++;
        continue;
      }
      if (s > m.index) {
        inside = true;
        break;
      }
      i = s;
    }
    if (!inside) return m.index + m[0].length - 1;
  }
  return -1;
}

const OTHER_LITERAL =
  /^(true|false|null|undefined|-?(0[xXbBoO][\da-fA-F_]+|\d[\d_.eE+-]*)|\{[\s\S]*\}|\[[\s\S]*\])$/;
/** What may follow a value: a type assertion (`as string`, `as const`, `satisfies Foo`). */
const TYPE_SUFFIX = /^(as|satisfies)\s+[\w$.<>[\]|&,\s'"]+$/;

/** Index of the first character of `text` that is not whitespace or inside a comment. */
function firstCodeIndex(text: string): number {
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipNonCode(text, i);
      continue;
    }
    return i;
  }
  return text.length;
}

/**
 * Kind of a value. For strings, `litStart`/`litLen` locate the string literal inside the value
 * (comments before it and a type assertion or comment after it are not part of it).
 */
function classify(value: string): {
  kind: FieldKind;
  text?: string;
  litStart?: number;
  litLen?: number;
} {
  const at = firstCodeIndex(value);
  const q = value[at];
  if (q === "'" || q === '"' || q === '`') {
    const end = endOfString(value, at);
    const literal = value.slice(at, end);
    const closed = literal.length >= 2 && literal.endsWith(q);
    const rest = stripComments(value.slice(end)).trim();
    if (closed && (q !== '`' || !/\$\{/.test(literal)) && (rest === '' || TYPE_SUFFIX.test(rest))) {
      return { kind: 'string', text: literal.slice(1, -1), litStart: at, litLen: literal.length };
    }
  }
  const bare = stripComments(value).trim();
  const noSuffix = bare.replace(/\s+(as|satisfies)\s+[\w$.<>[\]|&,\s]+$/, '').trim();
  return { kind: OTHER_LITERAL.test(noSuffix) ? 'other-literal' : 'expression' };
}

/** The `environment` object: whether it exists, its top-level fields and unkeyed entries. */
export function scanEnvironment(text: string): EnvironmentScan {
  const open = environmentObjectStart(text);
  if (open < 0) return { found: false, fields: [], unkeyed: [] };
  const fields: EnvField[] = [];
  const unkeyed: string[] = [];
  let depth = 0;
  let key: string | undefined;
  let valueStart = -1;
  let entryStart = open + 1;
  const finish = (end: number) => {
    if (key !== undefined && valueStart >= 0) {
      const raw = text.slice(valueStart, end);
      const lead = raw.length - raw.trimStart().length;
      const value = raw.trim();
      const c = classify(value);
      const start = valueStart + lead + (c.litStart ?? 0);
      fields.push({
        key,
        value,
        kind: c.kind,
        text: c.text,
        start,
        end: c.litLen !== undefined ? start + c.litLen : start + value.length,
      });
    } else {
      const entry = stripComments(text.slice(entryStart, end)).trim();
      if (entry) unkeyed.push(entry.slice(0, 60));
    }
    key = undefined;
    valueStart = -1;
  };
  let i = open;
  while (i < text.length) {
    const skip = skipNonCode(text, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    const c = text[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) {
        finish(i);
        break;
      }
    } else if (depth === 1 && c === ',') {
      finish(i);
      entryStart = i + 1;
    } else if (depth === 1 && c === ':' && key === undefined) {
      const k = stripComments(text.slice(entryStart, i))
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
      if (/^[\w$-]+$/.test(k)) {
        key = k;
        valueStart = i + 1;
      }
    }
    i++;
  }
  return { found: true, fields, unkeyed };
}

/**
 * Inserts `key: '<value>'` as the last entry of the `environment = { … }` object (value must be
 * a quote-free token such as base64url). Throws when there is no such object.
 */
export function appendEnvironmentField(text: string, key: string, value: string): string {
  const open = environmentObjectStart(text);
  const close = open < 0 ? -1 : closingBracket(text, open);
  if (close < 0) {
    throw new Error(
      'env encryption: aes-gcm needs `export const environment = { … }` in the env file.',
    );
  }
  const body = stripComments(text.slice(open + 1, close)).trim();
  const head = text.slice(0, close).trimEnd();
  // A comment ends `head` (comments become spaces): start a new line so `// …` cannot swallow it.
  const lead = stripComments(head).endsWith(' ') ? '\n' : '';
  const sep = body === '' || body.endsWith(',') ? ' ' : ' , ';
  return `${head}${lead}${sep}${key}: '${value}' ${text.slice(close)}`;
}

/** Top-level fields of the `environment` object (empty when there is none). */
export function environmentFields(text: string): EnvField[] {
  return scanEnvironment(text).fields;
}

/** The value of a JS string literal's content (escapes resolved). */
export function unescapeString(content: string): string {
  return content.replace(
    /\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g,
    (_, e: string) => {
      if (e[0] === 'u' && e[1] === '{') return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
      if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
      const map: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
        v: '\v',
        '0': '\0',
        '\n': '',
        '\r\n': '',
      };
      return map[e] ?? e;
    },
  );
}

/** True when offset `index` of `text` is code (not inside a comment, string or regex literal). */
export function isCodeAt(text: string, index: number): boolean {
  let i = 0;
  while (i < index) {
    const s = skipNonCode(text, i);
    if (s < 0) {
      i++;
      continue;
    }
    if (s > index) return false;
    i = s;
  }
  return true;
}

/** Offset of the bracket closing the one at `open` (`[`, `{` or `(`), skipping non-code; -1 if none. */
export function closingBracket(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const s = skipNonCode(text, i);
    if (s >= 0) {
      i = s;
      continue;
    }
    const c = text[i];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

export interface ScannedString extends QuotedString {
  /** Offset of the innermost unclosed `{`, `[` or `(` around the string, or -1 at the top level. */
  parent: number;
}

export interface Structure {
  strings: ScannedString[];
  /** Open bracket offset → its character and the bracket it sits in (-1 at the top level). */
  brackets: Map<number, { char: string; parent: number; close: number }>;
}

/** Strings and brackets with their nesting (one pass; comments, templates, regexes skipped). */
export function scanStructure(text: string): Structure {
  const strings: ScannedString[] = [];
  const brackets = new Map<number, { char: string; parent: number; close: number }>();
  const stack: number[] = [];
  const top = () => (stack.length > 0 ? stack[stack.length - 1] : -1);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const skip = skipNonCode(text, i);
    if (skip >= 0) {
      if (c === "'" || c === '"') {
        strings.push({
          start: i,
          end: skip,
          quote: c,
          content: text.slice(i + 1, skip - 1),
          parent: top(),
        });
      }
      i = skip;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      brackets.set(i, { char: c, parent: top(), close: text.length });
      stack.push(i);
    } else if (c === '}' || c === ']' || c === ')') {
      const open = stack.pop();
      const b = open !== undefined ? brackets.get(open) : undefined;
      if (b) b.close = i;
    }
    i++;
  }
  return { strings, brackets };
}

/** The first code character at or after `index` (comments and whitespace skipped). */
export function nextCode(text: string, index: number): string {
  let i = index;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipNonCode(text, i);
      continue;
    }
    return text.slice(i, i + 12);
  }
  return '';
}
