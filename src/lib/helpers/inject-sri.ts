import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface InjectSriOptions {
  distDir: string;
  /** Exact URLs allowed for external SRI; everything else external is skipped. */
  cdnAllowlist: string[];
  /**
   * Recompute an existing integrity on local files (the Angular build wrote it before the files
   * were stripped or obfuscated). Default false: tags that have one are left alone.
   */
  refresh?: boolean;
}

export function injectSri(opts: InjectSriOptions): void {
  if (!fs.existsSync(opts.distDir)) {
    throw new Error(`injectSri: distDir not found: ${opts.distDir}`);
  }
  const allowlist = new Set(opts.cdnAllowlist);

  for (const htmlFile of walkHtml(opts.distDir)) {
    let html = fs.readFileSync(htmlFile, 'utf8');

    if (opts.refresh) {
      html = refreshIntegrity(html, htmlFile, opts.distDir);
    }

    // <script src="...">
    html = html.replace(
      /<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/g,
      (full, before, src, after) => {
        if (/\bintegrity\s*=/.test(full)) return full;
        const hash = resolveHash(src, htmlFile, opts.distDir, allowlist);
        if (!hash) return full;
        return `<script${before} src="${src}" integrity="${hash}" crossorigin="anonymous"${after}>`;
      },
    );

    // <link rel="stylesheet" href="...">
    html = html.replace(
      /<link\b([^>]*?\brel\s*=\s*["']stylesheet["'][^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*)>/g,
      (full, allAttrs, href) => {
        if (/\bintegrity\s*=/.test(full)) return full;
        const hash = resolveHash(href, htmlFile, opts.distDir, allowlist);
        if (!hash) return full;
        return `<link${allAttrs.replace(href, href)} integrity="${hash}" crossorigin="anonymous">`;
      },
    );

    fs.writeFileSync(htmlFile, html, 'utf8');
  }
}

/** Recomputes integrity="…" on script/link tags whose src/href is a local file. */
function refreshIntegrity(html: string, htmlFile: string, distDir: string): string {
  return html.replace(/<(script|link)\b[^>]*>/gi, (tag) => {
    if (!/\bintegrity\s*=/i.test(tag)) return tag;
    const url = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!url || /^(?:[a-z]+:)?\/\//i.test(url) || /^[a-z]+:/i.test(url)) return tag;
    const hash = resolveHash(url, htmlFile, distDir, new Set());
    // A stale hash makes the browser refuse the file: fail instead of shipping it.
    if (!hash) {
      throw new Error(
        `injectSri: ${path.basename(htmlFile)} has an integrity for ${url}, which is not a file ` +
          'under the output; its hash cannot be refreshed (a deployUrl is not supported with sri)',
      );
    }
    const updated = tag.replace(/\bintegrity\s*=\s*["'][^"']*["']/i, `integrity="${hash}"`);
    return /\bcrossorigin\b/i.test(updated)
      ? updated
      : updated.replace(/\s*\/?>$/, (end) => ` crossorigin="anonymous"${end}`);
  });
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
    // Try to find a local mirror next to index.html
    const basename = src.split('/').pop() ?? '';
    const local = path.join(distDir, basename);
    if (!fs.existsSync(local)) return null;
    return sha384(local);
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

function* walkHtml(dir: string): IterableIterator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkHtml(full);
    else if (entry.isFile() && full.endsWith('.html')) yield full;
  }
}
