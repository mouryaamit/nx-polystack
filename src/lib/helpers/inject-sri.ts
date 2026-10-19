import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { servedRoot } from '../hardening/files';
import { attr, scanTags } from '../html/tags';

import { DEFAULT_NONCE_FILES, resolveNonceSettings } from './inject-nonce';

export interface InjectSriOptions {
  distDir: string;
  /** Exact URLs allowed for external SRI; everything else external is skipped. */
  cdnAllowlist: string[];
  /**
   * Recompute an existing integrity on local files (the Angular build wrote it before the files
   * were stripped or obfuscated). Default false: tags that have one are left alone.
   */
  refresh?: boolean;
  /** Pages to rewrite, relative to the served root (default ["index.html"]); assets/ never. */
  files?: string[];
}

const isRemote = (url: string) => /^(?:[a-z]+:)?\/\//i.test(url) || /^[a-z]+:/i.test(url);

/**
 * Adds integrity/crossorigin to the scripts and stylesheets of the served pages (index.html by
 * default) under distDir's served root, and with refresh recomputes integrity Angular wrote. Tags
 * are parsed (quotes and SSI directives respected) and edited in place: nothing else in a tag
 * moves.
 */
export function injectSri(opts: InjectSriOptions): void {
  if (!fs.existsSync(opts.distDir)) {
    throw new Error(`injectSri: distDir not found: ${opts.distDir}`);
  }
  const allowlist = new Set(opts.cdnAllowlist);
  const root = servedRoot(opts.distDir);
  let files: string[];
  try {
    files = resolveNonceSettings({ files: opts.files ?? DEFAULT_NONCE_FILES }).files;
  } catch (err) {
    throw new Error(`injectSri: ${(err as Error).message.replace('nonce.files', 'files')}`);
  }
  for (const rel of files) {
    const htmlFile = path.join(root, rel);
    if (!fs.existsSync(htmlFile)) continue;
    const html = fs.readFileSync(htmlFile, 'utf8');
    const out = sriHtml(html, htmlFile, opts.distDir, allowlist, opts.refresh ?? false);
    if (out !== html) fs.writeFileSync(htmlFile, out, 'utf8');
  }
}

function sriHtml(
  html: string,
  htmlFile: string,
  distDir: string,
  allowlist: Set<string>,
  refresh: boolean,
): string {
  const edits: Edit[] = [];
  for (const tag of scanTags(html)) {
    if (tag.name !== 'script' && tag.name !== 'link') continue;
    const urlAttr = attr(tag, tag.name === 'script' ? 'src' : 'href');
    const url = urlAttr?.value;
    if (!urlAttr || !url) continue;
    const integrity = attr(tag, 'integrity');
    const crossorigin = attr(tag, 'crossorigin');
    if (integrity) {
      if (!refresh || isRemote(url)) continue;
      const hash = resolveHash(url, htmlFile, distDir, new Set());
      // A stale hash makes the browser refuse the file: fail instead of shipping it.
      if (!hash) {
        throw new Error(
          `injectSri: ${path.basename(
            htmlFile,
          )} has an integrity for ${url}, which is not a file ` +
            'under the output; its hash cannot be refreshed (a deployUrl is not supported with sri)',
        );
      }
      edits.push({ start: integrity.start, end: integrity.end, text: `integrity="${hash}"` });
      if (!crossorigin) {
        edits.push({ start: tag.attrsEnd, end: tag.attrsEnd, text: ' crossorigin="anonymous"' });
      }
      continue;
    }
    if (tag.name === 'link' && !/(^|\s)stylesheet(\s|$)/i.test(attr(tag, 'rel')?.value ?? '')) {
      continue;
    }
    const hash = resolveHash(url, htmlFile, distDir, allowlist);
    if (!hash) continue;
    const added = ` integrity="${hash}"${crossorigin ? '' : ' crossorigin="anonymous"'}`;
    // Scripts: right after src (as before); links: after the last attribute.
    const at = tag.name === 'script' ? urlAttr.end : tag.attrsEnd;
    edits.push({ start: at, end: at, text: added });
  }
  let out = html;
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function resolveHash(
  src: string,
  htmlFile: string,
  distDir: string,
  allowlist: Set<string>,
): string | null {
  const isExternal = /^https?:\/\//.test(src);
  if (isExternal) {
    if (!allowlist.has(src)) return null;
    // A local mirror next to the page (the served root), else at the top of the output.
    const basename = src.split('/').pop() ?? '';
    const local = [path.dirname(htmlFile), distDir]
      .map((d) => path.join(d, basename))
      .find((f) => basename && fs.existsSync(f));
    return local ? sha384(local) : null;
  }
  const local = path.resolve(path.dirname(htmlFile), src);
  const resolved = path.resolve(distDir);
  if (!local.startsWith(resolved) || !fs.existsSync(local)) return null;
  return sha384(local);
}

function sha384(file: string): string {
  const buf = fs.readFileSync(file);
  const digest = crypto.createHash('sha384').update(buf).digest('base64');
  return `sha384-${digest}`;
}
