import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  injectCspNonce,
  injectNonceIntoHtml,
  NONCE_SSI_PLACEHOLDER,
  resolveNonceSettings,
} from '../../src/lib/helpers/inject-nonce';

describe('injectCspNonce', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-nonce-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds nonce attribute with SSI placeholder to <script src=...> tags', () => {
    const file = path.join(tmpDir, 'index.html');
    fs.writeFileSync(file, '<html><head><script src="main.js"></script></head></html>');
    injectCspNonce({ distDir: tmpDir });
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toContain(`nonce="${NONCE_SSI_PLACEHOLDER}"`);
    expect(out).toContain('main.js');
  });

  it('adds nonce to <style> blocks', () => {
    const file = path.join(tmpDir, 'index.html');
    fs.writeFileSync(file, '<html><head><style>body{color:red}</style></head></html>');
    injectCspNonce({ distDir: tmpDir });
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toContain(`<style nonce="${NONCE_SSI_PLACEHOLDER}">body{color:red}</style>`);
  });

  it('adds nonce to <link rel="stylesheet">', () => {
    const file = path.join(tmpDir, 'index.html');
    fs.writeFileSync(file, '<html><head><link rel="stylesheet" href="x.css"></head></html>');
    injectCspNonce({ distDir: tmpDir });
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toMatch(/nonce="[^"]+"/);
    expect(out).toContain('x.css');
  });

  it('adds <meta property="csp-nonce"> to <head>', () => {
    const file = path.join(tmpDir, 'index.html');
    fs.writeFileSync(file, '<html><head></head></html>');
    injectCspNonce({ distDir: tmpDir });
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toContain(`<meta property="csp-nonce" content="${NONCE_SSI_PLACEHOLDER}">`);
  });

  it('rewrites only the served index.html: other pages and assets/ stay byte-identical', () => {
    const page = '<html><head><script>x()</script></head></html>';
    const others = {
      'sub/index.html': page,
      'other.html': page,
      'assets/inline-locale-files/de.html': '<script type="application/l10n">{"a":1}</script>',
      'assets/fonts/demo.html': page,
    };
    for (const [rel, text] of Object.entries(others)) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, rel), text);
    }
    fs.writeFileSync(path.join(tmpDir, 'index.html'), page);
    expect(injectCspNonce({ distDir: tmpDir })).toEqual(['index.html']);
    for (const [rel, text] of Object.entries(others)) {
      expect(fs.readFileSync(path.join(tmpDir, rel), 'utf8')).toBe(text);
    }
    expect(fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8')).toContain('nonce=');
  });

  it('uses browser/index.html for the application builder', () => {
    fs.mkdirSync(path.join(tmpDir, 'browser'));
    fs.writeFileSync(path.join(tmpDir, 'browser', 'index.html'), '<style>a{}</style>');
    injectCspNonce({ distDir: tmpDir });
    expect(fs.readFileSync(path.join(tmpDir, 'browser', 'index.html'), 'utf8')).toBe(
      `<style nonce="${NONCE_SSI_PLACEHOLDER}">a{}</style>`,
    );
  });

  it('refuses nonce.files under assets/ or outside the served root', () => {
    for (const f of ['assets/a.html', '../x.html', 'main.js', '/abs.html']) {
      expect(() => resolveNonceSettings({ files: [f] })).toThrow(/nonce.files/);
    }
  });
});

describe('injectNonceIntoHtml legacy settings', () => {
  const legacy = resolveNonceSettings({
    placeholder: "<!--#echo var='UNIQUE_ID' -->",
    tags: 'legacy',
    position: 'after-tag-name',
    replaceTokens: ['random-csp-nonce'],
    addMeta: false,
    stripComments: true,
  });
  const P = "<!--#echo var='UNIQUE_ID' -->";

  it('matches the old build attribute for attribute', () => {
    const input = [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <!-- build: portal -->',
      '  <meta charset="utf-8">',
      '  <meta name="CSP-NONCE" content="random-csp-nonce">',
      '  <base href="/portal/">',
      '  <!--[if IE]><p>old</p><![endif]-->',
      '  <!--#include virtual="/ssi/head.html" -->',
      '  <link rel="icon" type="image/x-icon" href="favicon.ico">',
      '  <link rel="stylesheet" href="styles.abc123.css" media="print" onload="this.media=\'all\'">',
      '  <style>body{margin:0}</style>',
      '  <script>window[\'__cspNonce\'] = "random-csp-nonce";</script>',
      '</head>',
      '<body>',
      '  <app-root></app-root>',
      '  <script src="runtime.abc123.js" type="module"></script>',
      '  <script type="application/ld+json">{"@type":"WebSite"}</script>',
      '</body>',
      '</html>',
    ].join('\n');
    const out = injectNonceIntoHtml(input, legacy);
    expect(out).toBe(
      [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '  ',
        '  <meta charset="utf-8">',
        `  <meta name="CSP-NONCE" content="${P}">`,
        '  <base href="/portal/">',
        '  <!--[if IE]><p>old</p><![endif]-->',
        '  <!--#include virtual="/ssi/head.html" -->',
        `  <link nonce="${P}" rel="icon" type="image/x-icon" href="favicon.ico">`,
        `  <link nonce="${P}" rel="stylesheet" href="styles.abc123.css" media="print" onload="this.media='all'">`,
        `  <style nonce="${P}">body{margin:0}</style>`,
        `  <script nonce="${P}">window['__cspNonce'] = "${P}";</script>`,
        '</head>',
        '<body>',
        '  <app-root></app-root>',
        '  <script src="runtime.abc123.js" type="module"></script>',
        `  <script nonce="${P}" type="application/ld+json">{"@type":"WebSite"}</script>`,
        '</body>',
        '</html>',
      ].join('\n'),
    );
    expect(out).not.toContain('property="csp-nonce"');
  });

  it('fails when the placeholder would land in a single-quoted JS string', () => {
    expect(() =>
      injectNonceIntoHtml("<script>window.__cspNonce = 'random-csp-nonce';</script>", legacy),
    ).toThrow(/index.html:1: "random-csp-nonce" is inside '…'/);
  });

  it('a double-quoted placeholder in a double-quoted attribute keeps its tag parseable for SRI', () => {
    const html = injectNonceIntoHtml('<script src="a.js"></script>', resolveNonceSettings({}));
    expect(html).toBe(`<script src="a.js" nonce="${NONCE_SSI_PLACEHOLDER}"></script>`);
  });
});

describe('injectCspNonce placeholders', () => {
  it('uses the CSP_NONCE SSI placeholder and replaces placeholder nonces already in the page', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonce-ph-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'index.html'),
        '<html><head></head><body><script nonce="random-csp-nonce">x()</script>' +
          '<script nonce=\'{{NONCE}}\' src="a.js"></script><script nonce="abc123">y()</script>' +
          '<script data-nonce="nonce">z()</script></body></html>',
      );
      injectCspNonce({ distDir: dir });
      const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
      expect(NONCE_SSI_PLACEHOLDER).toBe('<!--#echo var="CSP_NONCE" -->');
      expect(html).toContain(`<script nonce="${NONCE_SSI_PLACEHOLDER}">x()</script>`);
      expect(html).toContain(`<script nonce="${NONCE_SSI_PLACEHOLDER}" src="a.js">`);
      expect(html).toContain('<script nonce="abc123">y()</script>');
      expect(html).toContain(
        `<script data-nonce="nonce" nonce="${NONCE_SSI_PLACEHOLDER}">z()</script>`,
      );
      expect(html).toContain(`<meta property="csp-nonce" content="${NONCE_SSI_PLACEHOLDER}">`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review fixes (NX-70)', () => {
  const defaults = resolveNonceSettings({});
  const legacy = resolveNonceSettings({
    placeholder: "<!--#echo var='UNIQUE_ID' -->",
    tags: 'legacy',
    replaceTokens: ['random-csp-nonce'],
    addMeta: false,
  });
  const nonces = (html: string) => (html.match(/nonce=/g) ?? []).length;

  it('characters that grow when lower-cased do not make the scanner skip a tag', () => {
    const html = injectNonceIntoHtml(
      `<head><title>${'İ'.repeat(20)}</title><style>a{}</style><script>x()</script></head>`,
      defaults,
    );
    expect(nonces(html)).toBe(2); // style, script
    expect(html).toContain('property="csp-nonce"');
  });

  it('a raw-text element ends only at a real closing tag', () => {
    const html = injectNonceIntoHtml(
      '<script>var s="</scripts><style>";</script><style>b{}</style>',
      defaults,
    );
    expect(html).toContain('var s="</scripts><style>";');
    expect(nonces(html)).toBe(2);
  });

  it('an unterminated tag does not stop the rest of the page from getting nonces', () => {
    const html = injectNonceIntoHtml(
      '<meta content="<!--#"><script>a</script><style>s</style>',
      defaults,
    );
    expect(html).toContain(`<style nonce="${NONCE_SSI_PLACEHOLDER}">`);
  });

  it('tokens: whole words only, nonce attributes first, quotes found on the line', () => {
    expect(injectNonceIntoHtml("<script nonce='random-csp-nonce'>a()</script>", legacy)).toBe(
      `<script nonce="<!--#echo var='UNIQUE_ID' -->">a()</script>`,
    );
    expect(injectNonceIntoHtml('<p data-v="random-csp-nonce-v2"></p>', legacy)).toContain(
      'random-csp-nonce-v2',
    );
    expect(() =>
      injectNonceIntoHtml("<script>var n='x random-csp-nonce y';</script>", legacy),
    ).toThrow(/inside '…'/);
  });

  it('stripComments keeps comments inside scripts and attributes', () => {
    const html = injectNonceIntoHtml(
      '<!-- a --><script>var t="<!-- x -->";</script><p title="<!-- y -->"></p><!--#echo var="X" -->',
      { ...defaults, stripComments: true, addMeta: false },
    );
    expect(html).toBe(
      `<script nonce="${NONCE_SSI_PLACEHOLDER}">var t="<!-- x -->";</script><p title="<!-- y -->"></p><!--#echo var="X" -->`,
    );
  });
});

describe('injectNonceIntoHtml every tag and ngCspNonce (NX-108)', () => {
  const P = "<!--#echo var='UNIQUE_ID' -->";
  const every = resolveNonceSettings({
    placeholder: P,
    tags: 'every',
    position: 'after-tag-name',
    ngCspNonce: 'app-root',
  });

  it('puts the nonce on every script, link and style, and ngCspNonce on the root element', () => {
    const out = injectNonceIntoHtml(
      [
        '<head><link rel="modulepreload" href="chunk.js"><link rel="icon" href="f.ico">',
        '<link rel="stylesheet" href="s.css"></head>',
        '<body><app-root></app-root><script src="main.js" type="module"></script></body>',
      ].join(''),
      every,
    );
    const n = `nonce="${P}"`;
    expect(out).toContain(`<link ${n} rel="modulepreload"`);
    expect(out).toContain(`<link ${n} rel="icon"`);
    expect(out).toContain(`<link ${n} rel="stylesheet"`);
    expect(out).toContain(`<script ${n} src="main.js"`);
    expect(out).toContain(`<app-root ngCspNonce="${P}"></app-root>`);
  });

  it('keeps an ngCspNonce already there, and all still skips non-stylesheet links', () => {
    expect(injectNonceIntoHtml('<app-root ngCspNonce="x"></app-root>', every)).toBe(
      '<app-root ngCspNonce="x"></app-root>',
    );
    const all = resolveNonceSettings({ placeholder: P });
    expect(injectNonceIntoHtml('<link rel="icon" href="f.ico">', all)).not.toContain('nonce');
  });

  it('refuses an ngCspNonce that is not a custom element name', () => {
    expect(() => resolveNonceSettings({ ngCspNonce: 'div' })).toThrow(
      'nonce.ngCspNonce must be the tag name of the root element',
    );
  });
});
