import * as fs from 'fs';
import * as path from 'path';

import { stripHtmlCommentsSafe } from '../html/tags';

import { listFiles } from './files';

export interface StripOptions {
  stripComments: boolean;
  /** Console methods whose calls are removed (e.g. log, debug, warn). */
  dropConsole: string[];
  /** Workspace root: terser is loaded from its node_modules. */
  repoRoot: string;
}

/** Files changed per kind, and notes on what was left alone. */
export interface StripResult {
  js: number;
  css: number;
  html: number;
  notes: string[];
}

export interface Terser {
  minify(code: string, options: object): Promise<{ code?: string }>;
}

/** The terser options pass uses (a subset of terser's MinifyOptions). */
export interface MinifyOptions {
  compress: false | { defaults: boolean; pure_funcs: string[]; side_effects: boolean };
  mangle: false;
  format: { comments: false | 'some'; ascii_only: boolean };
  module: boolean;
}

const SKIP_DIRS = ['assets'];
/** A tag with Angular's hydration attribute `ngh`. */
const NGH_ATTRIBUTE = /<[^>]*\sngh(?:\s*=|[\s/>])/;
const TOP_LEVEL_MODULE_SYNTAX = /^\s*(import|export)\b/m;
const HYDRATION_NOTE = 'html comments kept (SSR hydration needs them)';

/**
 * Strips comments from the JS, CSS and served-root HTML under root and removes the listed console
 * calls from the JS (one terser pass per file). assets/ is never touched; files are rewritten only
 * when they change.
 */
export async function stripOutput(served: string, o: StripOptions): Promise<StripResult> {
  const root = path.resolve(served);
  const counts: StripResult = { js: 0, css: 0, html: 0, notes: [] };
  if (!o.stripComments && o.dropConsole.length === 0) return counts;

  const jsFiles = listFiles(root, ['js', 'mjs'], { skipDirs: SKIP_DIRS });
  // terser is only loaded (and only has to be installed) when there is JS to process.
  if (jsFiles.length > 0) {
    const terser = loadTerser(o.repoRoot);
    for (const file of jsFiles) {
      const code = fs.readFileSync(file, 'utf8');
      const out = await minifyFile(terser, code, file, root, o);
      if (rewrite(file, code, out)) counts.js++;
    }
  }
  if (!o.stripComments) return counts;

  for (const file of listFiles(root, ['css'], { skipDirs: SKIP_DIRS })) {
    const css = fs.readFileSync(file, 'utf8');
    if (rewrite(file, css, stripCssComments(css))) counts.css++;
  }
  if (fs.existsSync(path.join(root, 'index.csr.html'))) {
    counts.notes.push(`index.csr.html found: ${HYDRATION_NOTE}`);
    return counts;
  }
  for (const file of listFiles(root, ['html']).filter((f) => path.dirname(f) === root)) {
    const html = fs.readFileSync(file, 'utf8');
    if (NGH_ATTRIBUTE.test(html)) {
      counts.notes.push(`${path.basename(file)} has ngh attributes: ${HYDRATION_NOTE}`);
    } else if (rewrite(file, html, stripHtmlComments(html))) {
      counts.html++;
    }
  }
  return counts;
}

/** Removes `/* … *\/` blocks (license ones too) outside quoted strings and unquoted url(…). */
export function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    const url = unquotedUrlEnd(css, i);
    if (url > i) {
      out += css.slice(i, url);
      i = url;
    } else if (c === '"' || c === "'") {
      const end = stringEnd(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Comments outside tags and <script>/<style> content; SSI and IE conditionals stay. */
export function stripHtmlComments(html: string): string {
  return stripHtmlCommentsSafe(html);
}

/**
 * Index just past an unquoted `url(…)` starting at `start` (its content may hold `/*`, e.g. a raw
 * SVG data URI); `start` when there is none there. A quoted url is left to the string handling.
 */
function unquotedUrlEnd(css: string, start: number): number {
  if (css.slice(start, start + 4).toLowerCase() !== 'url(') return start;
  if (start > 0 && /[\w-]/.test(css[start - 1])) return start;
  let i = start + 4;
  while (/\s/.test(css[i] ?? '')) i++;
  if (css[i] === '"' || css[i] === "'") return start;
  const close = css.indexOf(')', i);
  return close < 0 ? css.length : close + 1;
}

/** Index just past the string starting at `start` (escapes skipped; unterminated: the end). */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
  return Math.min(i + 1, text.length);
}

/**
 * One terser pass over a file. A file guessed to be an ES module that terser cannot parse as one
 * is tried once more as a script; when neither parses, the error names the file.
 */
export async function minifyFile(
  terser: Terser,
  code: string,
  file: string,
  root: string,
  o: StripOptions,
): Promise<string> {
  const options = minifyOptions(file, code, root, o);
  const attempts = options.module ? [options, { ...options, module: false }] : [options];
  let firstError: Error | undefined;
  for (const attempt of attempts) {
    try {
      const result = await terser.minify(code, attempt);
      return result.code ?? code;
    } catch (err) {
      firstError ??= err as Error;
    }
  }
  throw new Error(
    `${path.relative(root, file)}: terser could not parse it (${firstError?.message})`,
  );
}

/**
 * terser options for one file: only the listed console calls are removed (no other compression),
 * no mangling, ASCII-only output. ES modules: .mjs, files with top-level import/export, and
 * everything the application builder writes (served from browser/).
 */
export function minifyOptions(
  file: string,
  code: string,
  root: string,
  o: StripOptions,
): MinifyOptions {
  return {
    compress: o.dropConsole.length
      ? {
          defaults: false,
          pure_funcs: o.dropConsole.map((m) => `console.${m}`),
          side_effects: true,
        }
      : false,
    mangle: false,
    format: { comments: o.stripComments ? false : 'some', ascii_only: true },
    module: isModuleCode(file, code, root),
  };
}

/** .mjs, files with top-level import/export, and everything served from browser/ (application builder). */
export function isModuleCode(file: string, code: string, root: string): boolean {
  return (
    file.endsWith('.mjs') || path.basename(root) === 'browser' || TOP_LEVEL_MODULE_SYNTAX.test(code)
  );
}

function loadTerser(repoRoot: string): Terser {
  let resolved: string;
  try {
    resolved = require.resolve('terser', { paths: [repoRoot, __dirname] });
  } catch {
    throw new Error(
      'stripComments/dropConsole need terser in the workspace devDependencies (npm i -D terser)',
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(resolved) as Terser;
}

function rewrite(file: string, before: string, after: string): boolean {
  if (after === before) return false;
  fs.writeFileSync(file, after);
  return true;
}
