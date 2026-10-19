import * as fs from 'fs';
import * as path from 'path';

import { servedRoot } from '../hardening/files';
import { stripHtmlComments } from '../hardening/strip';
import { applyInsertions, attr, HtmlTag, Insertion, scanTags } from '../html/tags';

/** Filled per request by the server config `pstack csp` writes (Apache SSI, Nginx sub_filter). */
export const NONCE_SSI_PLACEHOLDER = '<!--#echo var="CSP_NONCE" -->';

/** Which tags get the nonce: all = every script, style and stylesheet link; legacy = inline scripts, every link, every style. */
export type NonceTags = 'all' | 'legacy';
export type NoncePosition = 'end' | 'after-tag-name';

export interface NonceSettings {
  /** What the server replaces per request. Default NONCE_SSI_PLACEHOLDER. */
  placeholder?: string;
  tags?: NonceTags;
  /** Where the attribute goes: after the last attribute (default) or right after the tag name. */
  position?: NoncePosition;
  /** Text replaced by the placeholder anywhere in the page (e.g. "random-csp-nonce"). */
  replaceTokens?: string[];
  /** Add <meta property="csp-nonce" content="…"> to <head> (default true). */
  addMeta?: boolean;
  /** Pages to rewrite, relative to the served root (default ["index.html"]). */
  files?: string[];
  /** Remove HTML comments (SSI directives and IE conditionals stay) from those pages. */
  stripComments?: boolean;
}

export interface InjectNonceOptions extends NonceSettings {
  /** The build output folder; pages are found under its served root (itself or browser/). */
  distDir: string;
}

export const DEFAULT_NONCE_FILES = ['index.html'];

/** Nonce values left in a page by hand that stand for "fill me in" (as runtime/csp-nonce reads them). */
const PLACEHOLDER_NONCE =
  /((?<![\w-])nonce\s*=\s*)(["'])(random-csp-nonce|nonce|csp-nonce|\{\{[^"']*\}\}|\$\{[^"']*\}|%[^"']*%)\2/gi;

/**
 * Checks the nonce settings of a release target; throws naming the option. Returns them with the
 * defaults filled in.
 */
export function resolveNonceSettings(raw: NonceSettings | undefined): Required<NonceSettings> {
  const s = raw ?? {};
  if (typeof s !== 'object' || Array.isArray(s)) throw new Error('nonce must be an object');
  const placeholder = s.placeholder ?? NONCE_SSI_PLACEHOLDER;
  if (typeof placeholder !== 'string' || !placeholder.trim() || /[\r\n]/.test(placeholder)) {
    throw new Error('nonce.placeholder must be one non-empty line');
  }
  const tags = s.tags ?? 'all';
  if (tags !== 'all' && tags !== 'legacy') throw new Error('nonce.tags must be "all" or "legacy"');
  const position = s.position ?? 'end';
  if (position !== 'end' && position !== 'after-tag-name') {
    throw new Error('nonce.position must be "end" or "after-tag-name"');
  }
  const replaceTokens = s.replaceTokens ?? [];
  if (
    !Array.isArray(replaceTokens) ||
    !replaceTokens.every((t) => typeof t === 'string' && /^[A-Za-z0-9_-]{4,}$/.test(t))
  ) {
    throw new Error(
      'nonce.replaceTokens must be a list of tokens (letters, digits, _ and -, at least 4)',
    );
  }
  const files = s.files ?? DEFAULT_NONCE_FILES;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('nonce.files must be a non-empty list of .html files');
  }
  for (const f of files) {
    const norm = typeof f === 'string' ? path.posix.normalize(f.replace(/\\/g, '/')) : '';
    if (
      !norm.endsWith('.html') ||
      norm.startsWith('/') ||
      norm.startsWith('..') ||
      norm === 'assets' ||
      norm.startsWith('assets/')
    ) {
      throw new Error(
        `nonce.files: "${f}" must be an .html file under the served root, not under assets/`,
      );
    }
  }
  return {
    placeholder,
    tags,
    position,
    replaceTokens,
    addMeta: s.addMeta ?? true,
    files,
    stripComments: s.stripComments ?? false,
  };
}

function wantsNonce(tag: HtmlTag, mode: NonceTags): boolean {
  if (tag.name === 'style') return true;
  if (tag.name === 'script') return mode === 'all' || !attr(tag, 'src');
  if (tag.name === 'link') {
    if (mode === 'legacy') return true;
    return /(^|\s)stylesheet(\s|$)/i.test(attr(tag, 'rel')?.value ?? '');
  }
  return false;
}

/** The quote character of the string the text at `at` sits in on its line, if any. */
function enclosingQuote(text: string, at: number, length: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  let lineEnd = text.indexOf('\n', at + length);
  if (lineEnd < 0) lineEnd = text.length;
  const before = text.slice(lineStart, at);
  const after = text.slice(at + length, lineEnd);
  // The nearest quote before the token is open when it appears an odd number of times before it
  // and closes after it on the same line.
  let best: { q: string; pos: number } | undefined;
  for (const q of ['"', "'", '`']) {
    const pos = before.lastIndexOf(q);
    if (pos < 0 || before.split(q).length % 2 !== 0 || !after.includes(q)) continue;
    if (!best || pos > best.pos) best = { q, pos };
  }
  return best?.q;
}

/**
 * Replaces every whole token by the placeholder in one pass (a token is not matched inside a
 * longer word or inside text an earlier replacement inserted); refuses a token inside quotes that
 * the placeholder also uses, as the replaced text would end that string.
 */
function replaceTokens(html: string, tokens: string[], placeholder: string, file: string): string {
  if (tokens.length === 0) return html;
  const alternation = [...tokens]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[-]/g, '\\-'))
    .join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_-])(?:${alternation})(?![A-Za-z0-9_-])`, 'g');
  return html.replace(re, (token: string, at: number) => {
    const q = enclosingQuote(html, at, token.length);
    if (q && placeholder.includes(q)) {
      const line = html.slice(0, at).split('\n').length;
      throw new Error(
        `${file}:${line}: "${token}" is inside ${q}…${q}, and the nonce placeholder ` +
          `${placeholder} holds ${q}: the replaced text would end that string. Change the ` +
          'quotes in the page or nonce.placeholder.',
      );
    }
    return placeholder;
  });
}

/** The page with the nonce placeholder where the settings say. */
export function injectNonceIntoHtml(
  input: string,
  settings: Required<NonceSettings>,
  file = 'index.html',
): string {
  let html = settings.stripComments ? stripHtmlComments(input) : input;
  // Placeholder nonces already in the page get the server-filled one (double-quoted) first, so a
  // nonce='random-csp-nonce' attribute is never seen as a token in single quotes.
  html = html.replace(PLACEHOLDER_NONCE, (_m, a: string) => `${a}"${settings.placeholder}"`);
  html = replaceTokens(html, settings.replaceTokens, settings.placeholder, file);

  const insertions: Insertion[] = [];
  const nonceAttr = `nonce="${settings.placeholder}"`;
  for (const tag of scanTags(html)) {
    if (!wantsNonce(tag, settings.tags) || attr(tag, 'nonce')) continue;
    insertions.push(
      settings.position === 'after-tag-name'
        ? { at: tag.nameEnd, text: ` ${nonceAttr}` }
        : { at: tag.attrsEnd, text: ` ${nonceAttr}` },
    );
  }
  html = applyInsertions(html, insertions);

  if (settings.addMeta && !/property="csp-nonce"/.test(html)) {
    const head = scanTags(html).find((t) => t.name === 'head');
    if (head) {
      const meta = `<meta property="csp-nonce" content="${settings.placeholder}">`;
      html = applyInsertions(html, [{ at: head.end, text: `\n  ${meta}` }]);
    }
  }
  return html;
}

/**
 * Writes the nonce placeholder into the served pages (index.html by default) under distDir's
 * served root. Nothing else is touched: third-party pages under assets/ are never served through
 * SSI, so a placeholder there would stay raw.
 */
export function injectCspNonce(opts: InjectNonceOptions): string[] {
  if (!fs.existsSync(opts.distDir)) {
    throw new Error(`injectCspNonce: distDir not found: ${opts.distDir}`);
  }
  const settings = resolveNonceSettings(opts);
  const root = servedRoot(opts.distDir);
  const written: string[] = [];
  for (const rel of settings.files) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    const out = injectNonceIntoHtml(html, settings, rel);
    if (out !== html) {
      fs.writeFileSync(file, out, 'utf8');
      written.push(rel);
    }
  }
  return written;
}
