import * as fs from 'fs';
import * as path from 'path';

import { NonceSettings, NonceTags } from '../../lib/helpers/inject-nonce';

/*
 * A source that fills CSP nonces with its own post-build script (`"postbuildapp": "node
 * inject-nonce.js '/'"`): the script writes an Apache SSI echo (`<!--#echo var='UNIQUE_ID' -->`)
 * into index.html for the server to fill per request. pstack's release target does the same with
 * `secure: true` and `nonce` options; this reads the script and returns the matching options, so
 * the migrated app ships the markup the server expects.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface NonceScript {
  /** npm script names that run it, sorted. */
  scripts: string[];
  /** The script file, source-relative. */
  file: string;
  /** Release `nonce` options matching what the script writes. */
  nonce: NonceSettings;
  /** What could not be read from the script (the default is used). */
  unsure: string[];
}

/** Script text without // line comments and block comments (strings are left alone). */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/**
 * The nonce options a post-build script implies, when it writes an Apache SSI echo as the nonce;
 * undefined for any other script.
 */
export function nonceFromScript(
  text: string,
  indexHtml?: string,
): (NonceSettings & { unsure: string[] }) | undefined {
  const code = codeOf(text);
  // The nonce value: a string literal holding an SSI echo.
  const literal = /(["'`])(<!--#echo\s+var=(["']?)\w+\3\s*-->)\1/.exec(code);
  if (!literal || !/nonce/i.test(code)) return undefined;
  const placeholder = literal[2];
  const unsure: string[] = [];

  // Which tags it gives the nonce: html.replace(/<script…/, …), /<link…/, /<style…/.
  const replaced = (tag: string) =>
    [
      ...code.matchAll(
        new RegExp(`\\.replace\\(\\s*\\/<${tag}([^/]*)\\/[gimsuy]*\\s*,\\s*([^)]*)\\)`, 'g'),
      ),
    ].map((m) => ({ pattern: m[1], into: m[2] }));
  const scripts = replaced('script');
  const links = replaced('link');
  const styles = replaced('style');
  const inlineOnly =
    scripts.length > 0 && scripts.every((s) => /\(\?!\[\^>\]\*\\b?src=/.test(s.pattern));
  let tags: NonceTags | undefined;
  if (scripts.length > 0 && links.length > 0 && styles.length > 0) {
    tags = inlineOnly ? 'legacy' : 'every';
  } else if (scripts.length > 0 || links.length > 0 || styles.length > 0) {
    unsure.push(
      `the script gives the nonce only to ${[
        scripts.length > 0 ? (inlineOnly ? 'inline scripts' : 'scripts') : '',
        links.length > 0 ? 'links' : '',
        styles.length > 0 ? 'styles' : '',
      ]
        .filter(Boolean)
        .join(', ')}; pstack's "all" (every script, style and stylesheet link) is used`,
    );
  }

  // Where: `<script nonce="…"$1>` puts it right after the tag name.
  const all = [...scripts, ...links, ...styles];
  const position = all.some((r) => /<\w+\s+nonce=/.test(r.into))
    ? 'after-tag-name'
    : all.length > 0
    ? 'end'
    : undefined;

  // Tokens it replaces everywhere: html.replace(/random-csp-nonce/g, …).
  const tokens = [
    ...new Set(
      [...code.matchAll(/\.replace\(\s*\/([A-Za-z][\w-]{3,})\/[gimsuy]*\s*,/g)]
        .map((m) => m[1])
        .filter((t) => /nonce/i.test(t)),
    ),
  ].sort();

  const nonce: NonceSettings & { unsure: string[] } = { placeholder, unsure };
  if (tags) nonce.tags = tags;
  if (position) nonce.position = position;
  if (tokens.length > 0) nonce.replaceTokens = tokens;
  // The page already says where the nonce goes (a CSP-NONCE meta with a token): no second meta.
  if (indexHtml && /<meta[^>]+name=["']csp-nonce["']/i.test(indexHtml)) nonce.addMeta = false;
  return nonce;
}

/**
 * The source's post-build nonce script for an app: an npm script named post<something> whose name
 * holds the app's name (or any such script when `single`), running `node <file>.js`.
 */
export function readNonceScript(
  sourceDir: string,
  scripts: Record<string, string> | undefined,
  app: string,
  indexHtml: string | undefined,
  single: boolean,
): NonceScript | undefined {
  const found = new Map<string, string[]>();
  for (const [name, cmd] of Object.entries(scripts ?? {})) {
    if (typeof cmd !== 'string' || !/^post/.test(name)) continue;
    if (!single && !name.toLowerCase().includes(app.toLowerCase())) continue;
    const node = /\bnode\s+(['"]?)([^\s'"]+\.(?:c|m)?js)\1/.exec(cmd);
    if (!node) continue;
    const file = path.posix.normalize(node[2].replace(/^\.\//, ''));
    found.set(file, [...(found.get(file) ?? []), name]);
  }
  for (const [file, names] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(sourceDir, ...file.split('/')), 'utf8');
    } catch {
      continue;
    }
    const settings = nonceFromScript(text, indexHtml);
    if (!settings) continue;
    const { unsure, ...nonce } = settings;
    return { scripts: names.sort(), file, nonce, unsure };
  }
  return undefined;
}

/**
 * Puts `secure: true` and the script's `nonce` options on the release target's options (unless
 * the target already sets `nonce`), and returns the report line.
 */
export function applyNonceScript(release: unknown, found: NonceScript): string | undefined {
  if (!isObject(release) || !isObject(release['options'])) return undefined;
  const options = release['options'] as Json;
  if (options['nonce'] !== undefined) return undefined;
  options['secure'] = true;
  options['nonce'] = found.nonce;
  const settings = Object.entries(found.nonce)
    .map(([k, v]) => `${k} ${JSON.stringify(v)}`)
    .join(', ');
  return (
    `CSP nonce: the source's post-build script \`${found.file}\` (${found.scripts
      .map((s) => `\`${s}\``)
      .join(', ')}) writes the nonce into index.html; the release target does the same now ` +
    `(\`secure: true\`, nonce: ${settings}), so the script is not needed` +
    (found.unsure.length > 0 ? `. Check: ${found.unsure.join('; ')}` : '')
  );
}
