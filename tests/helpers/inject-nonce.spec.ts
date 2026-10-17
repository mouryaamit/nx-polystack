import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { injectCspNonce, NONCE_SSI_PLACEHOLDER } from '../../src/lib/helpers/inject-nonce';

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

  it('walks into subdirectories and processes html files there', () => {
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub);
    const innerFile = path.join(sub, 'index.html');
    fs.writeFileSync(innerFile, '<html><head></head></html>');
    injectCspNonce({ distDir: tmpDir });
    expect(fs.readFileSync(innerFile, 'utf8')).toContain('csp-nonce');
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
