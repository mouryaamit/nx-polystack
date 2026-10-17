import * as fs from 'fs';
import * as path from 'path';

import { CheckResult, listFiles } from './files';
import { CheckMode } from './options';

/** A plaintext encrypted in this build, with the env key holding it. Never logged or written. */
export interface Secret {
  key: string;
  value: string;
  /** Declared by a profile under a non-sensitive key: public by the app's own configuration. */
  public?: boolean;
}

const SCANNED_EXTS = ['js', 'mjs', 'cjs', 'html', 'css', 'json', 'txt', 'map'];
const SKIPPED_FILES = new Set(['3rdpartylicenses.txt']);
const MIN_LENGTH = 4;
const HINT = 'LEAK_CHECK=warn or "leakCheck": "warn" to report only';

interface Needle {
  keys: string[];
  public: boolean;
  /** Raw, JSON-escaped and \u/\x-escaped forms (every file). */
  patterns: RegExp[];
  /** HTML-entity form (html files). */
  htmlPatterns: RegExp[];
}

/**
 * Leak check: plaintexts of encrypted values found (as whole tokens, raw or JSON-escaped) in the
 * output under root. Messages name the file and the key(s), never the value. A value public in
 * every place it is declared is only a warning; fail → errors, warn → warnings, off → nothing.
 */
export function checkLeaks(root: string, secrets: Secret[], mode: CheckMode): CheckResult {
  const result: CheckResult = { errors: [], warnings: [] };
  const needles = needlesFor(secrets);
  if (mode === 'off' || needles.length === 0) return result;

  const hits: string[] = [];
  for (const file of listFiles(root, SCANNED_EXTS)) {
    if (SKIPPED_FILES.has(path.basename(file))) continue;
    const text = fs.readFileSync(file, 'utf8');
    const shown = path.relative(root, file);
    const html = path.extname(file).toLowerCase() === '.html';
    const found = (n: Needle) =>
      [...n.patterns, ...(html ? n.htmlPatterns : [])].some((p) => p.test(text));
    for (const n of needles.filter(found)) {
      const message = `${shown}: plaintext of ${n.keys.join(', ')} (encrypted in the env files)`;
      if (n.public) {
        result.warnings.push(`${message}; a profile declares it under a non-sensitive key`);
      } else {
        hits.push(message);
      }
    }
  }
  if (hits.length === 0) return result;

  const messages = [...hits, `${hits.length} leak(s) of encrypted values in the output; ${HINT}`];
  if (mode === 'fail') result.errors.push(...messages);
  else result.warnings.push(...messages);
  return result;
}

/** One needle per distinct value (4+ characters), with every key holding it. */
function needlesFor(secrets: Secret[]): Needle[] {
  const byValue = new Map<string, Secret[]>();
  for (const s of secrets) {
    if (s.value.length < MIN_LENGTH) continue;
    byValue.set(s.value, [...(byValue.get(s.value) ?? []), s]);
  }
  return [...byValue].map(([value, holders]) => ({
    keys: [...new Set(holders.map((h) => h.key))],
    public: holders.every((h) => h.public),
    patterns: patternsFor(textForms(value)),
    htmlPatterns: patternsFor([htmlEscape(value)].filter((f) => f !== value)),
  }));
}

/**
 * How a value can appear in built JS/JSON: raw, JSON-escaped and, when it has non-ASCII
 * characters, \uXXXX-escaped (either hex case) and terser's ascii_only form (\xXX up to 0xff).
 */
function textForms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  const forms = [value, json];
  if (/[\u0080-\uffff]/.test(value)) {
    const hex = (c: number, width: number) => c.toString(16).padStart(width, '0');
    const escapes = [
      (c: number) => `\\u${hex(c, 4)}`,
      (c: number) => `\\u${hex(c, 4).toUpperCase()}`,
      (c: number) => (c <= 0xff ? `\\x${hex(c, 2)}` : `\\u${hex(c, 4)}`),
    ];
    for (const escape of escapes) {
      forms.push(json.replace(/[\u0080-\uffff]/g, (ch) => escape(ch.charCodeAt(0))));
    }
  }
  return forms;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function patternsFor(forms: string[]): RegExp[] {
  return [...new Set(forms)].map(wholeToken);
}

function wholeToken(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
}
