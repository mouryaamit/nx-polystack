import * as fs from 'fs';
import * as path from 'path';

import { quotedStrings } from './env-file';

/** `${NAME}` inside a quoted string (NAME: letters, digits, underscores; not starting with a digit). */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Names of the `${NAME}` placeholders in the file's quoted strings, in order, deduplicated. */
export function placeholderNames(text: string): string[] {
  const names = new Set<string>();
  for (const s of quotedStrings(text)) {
    for (const m of s.content.matchAll(PLACEHOLDER)) names.add(m[1]);
  }
  return [...names];
}

const PROXIES = new WeakSet<object>();
const isProxy = (o: object) => PROXIES.has(o);

/** Escapes a value for a string literal with the given quote. */
function escapeFor(value: string, quote: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quote, 'g'), `\\${quote}`)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

export interface FillResult {
  text: string;
  filled: string[];
  missing: string[];
}

/** Replaces `${NAME}` in quoted strings with `vars[NAME]`; template literals are not touched. */
export function fillPlaceholders(
  text: string,
  vars: Record<string, string | undefined>,
): FillResult {
  const filled = new Set<string>();
  const missing = new Set<string>();
  let out = '';
  let last = 0;
  for (const s of quotedStrings(text)) {
    if (!s.content.includes('${')) continue;
    const content = s.content.replace(PLACEHOLDER, (whole, name: string) => {
      const v =
        Object.prototype.hasOwnProperty.call(vars, name) || isProxy(vars) ? vars[name] : undefined;
      if (typeof v !== 'string') {
        missing.add(name);
        return whole;
      }
      filled.add(name);
      return escapeFor(v, s.quote);
    });
    out += text.slice(last, s.start + 1) + content;
    last = s.end - 1;
  }
  out += text.slice(last);
  return { text: out, filled: [...filled], missing: [...missing] };
}

/** `NAME=value` lines (`#` comments, optional `export `, optional matching quotes). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[m[1]] = v;
  }
  return out;
}

export const DOT_ENV_LOCAL = '.env.local';

/** process.env first, then `.env.local` at the workspace root. */
export function placeholderVars(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const file = path.join(repoRoot, DOT_ENV_LOCAL);
  const local = fs.existsSync(file) ? parseDotEnv(fs.readFileSync(file, 'utf8')) : {};
  const own = (o: Record<string, string | undefined>, k: string) =>
    Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
  const proxy = new Proxy({} as Record<string, string | undefined>, {
    get: (_t, name: string) => own(env, name) ?? own(local, name),
  });
  PROXIES.add(proxy);
  return proxy;
}
