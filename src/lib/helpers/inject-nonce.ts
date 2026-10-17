import * as fs from 'fs';
import * as path from 'path';

export interface InjectNonceOptions {
  /** Directory to recursively scan for *.html files. */
  distDir: string;
}

/** Filled per request by the server config `pstack csp` writes (Apache SSI, Nginx sub_filter). */
export const NONCE_SSI_PLACEHOLDER = '<!--#echo var="CSP_NONCE" -->';

/** Nonce values left in a page by hand that stand for "fill me in" (as runtime/csp-nonce reads them). */
const PLACEHOLDER_NONCE =
  /((?<![\w-])nonce\s*=\s*)(["'])(random-csp-nonce|nonce|csp-nonce|\{\{[^"']*\}\}|\$\{[^"']*\}|%[^"']*%)\2/gi;

export function injectCspNonce(opts: InjectNonceOptions): void {
  if (!fs.existsSync(opts.distDir)) {
    throw new Error(`injectCspNonce: distDir not found: ${opts.distDir}`);
  }
  for (const htmlFile of walkHtml(opts.distDir)) {
    let html = fs.readFileSync(htmlFile, 'utf8');

    // Placeholder nonces already in the page get the server-filled one too.
    html = html.replace(
      PLACEHOLDER_NONCE,
      (_m, attr: string) => `${attr}"${NONCE_SSI_PLACEHOLDER}"`,
    );

    // Add nonce to <script> tags (with or without src)
    html = html.replace(/<script\b((?:[^>]*?)?)>/g, (full, attrs) => {
      if (/(?<![\w-])nonce\s*=/.test(attrs)) return full;
      const trimmed = attrs.trimEnd();
      return `<script${trimmed ? trimmed : ''} nonce="${NONCE_SSI_PLACEHOLDER}">`;
    });

    // Add nonce to <style> tags
    html = html.replace(/<style\b((?:[^>]*?)?)>/g, (full, attrs) => {
      if (/(?<![\w-])nonce\s*=/.test(attrs)) return full;
      const trimmed = attrs.trimEnd();
      return `<style${trimmed ? trimmed : ''} nonce="${NONCE_SSI_PLACEHOLDER}">`;
    });

    // Add nonce to <link rel="stylesheet"> tags
    html = html.replace(
      /<link\b((?:[^>]*?)\brel\s*=\s*["']stylesheet["'](?:[^>]*?))>/g,
      (full, attrs) => {
        if (/(?<![\w-])nonce\s*=/.test(attrs)) return full;
        return `<link${attrs} nonce="${NONCE_SSI_PLACEHOLDER}">`;
      },
    );

    // Add <meta property="csp-nonce"> inside <head>
    if (!/property="csp-nonce"/.test(html)) {
      const metaTag = `<meta property="csp-nonce" content="${NONCE_SSI_PLACEHOLDER}">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>\n  ${metaTag}`);
      }
    }

    fs.writeFileSync(htmlFile, html, 'utf8');
  }
}

function* walkHtml(dir: string): IterableIterator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkHtml(full);
    else if (entry.isFile() && full.endsWith('.html')) yield full;
  }
}
