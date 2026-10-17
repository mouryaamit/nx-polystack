import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { injectSri } from '../../src/lib/helpers/inject-sri';

describe('injectSri', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-sri-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds integrity sha384-... and crossorigin to local <script src> assets', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.js'), 'console.log("x");');
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<html><head><script src="main.js"></script></head></html>',
    );
    injectSri({ distDir: tmpDir, cdnAllowlist: [] });
    const out = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8');
    expect(out).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(out).toContain('crossorigin="anonymous"');
  });

  it('skips external CDN URLs not in allowlist', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<html><head><script src="https://cdn.example.com/lib.js"></script></head></html>',
    );
    injectSri({ distDir: tmpDir, cdnAllowlist: [] });
    const out = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8');
    expect(out).not.toMatch(/integrity=/);
  });

  it('throws when distDir does not exist', () => {
    expect(() => injectSri({ distDir: '/nope', cdnAllowlist: [] })).toThrow(/not found/i);
  });
});

describe('injectSri refresh', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-sri-r-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sri = (text: string) =>
    `sha384-${crypto.createHash('sha384').update(text).digest('base64')}`;

  it('recomputes a stale integrity on local scripts, stylesheets and modulepreload links', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.js'), 'rewritten');
    fs.writeFileSync(path.join(tmpDir, 'chunk.js'), 'chunk');
    fs.writeFileSync(path.join(tmpDir, 'styles.css'), 'body{}');
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<html><head>' +
        '<link rel="stylesheet" href="styles.css" crossorigin="anonymous" integrity="sha384-old1">' +
        '<link rel="modulepreload" href="chunk.js" integrity="sha384-old2" crossorigin="anonymous">' +
        '</head><body>' +
        '<script src="main.js" type="module" crossorigin="anonymous" integrity="sha384-old3"></script>' +
        '<script src="https://cdn.example.com/x.js" integrity="sha384-cdn"></script>' +
        '</body></html>',
    );
    injectSri({ distDir: tmpDir, cdnAllowlist: [], refresh: true });
    const out = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8');
    expect(out).toContain(`href="styles.css" crossorigin="anonymous" integrity="${sri('body{}')}"`);
    expect(out).toContain(`href="chunk.js" integrity="${sri('chunk')}" crossorigin="anonymous"`);
    expect(out).toContain(
      `src="main.js" type="module" crossorigin="anonymous" integrity="${sri('rewritten')}"`,
    );
    expect(out).toContain('integrity="sha384-cdn"');
    expect(out.match(/crossorigin/g)).toHaveLength(3);
  });

  it('adds crossorigin when a refreshed tag lacks it', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.js'), 'x');
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<script src="main.js" integrity="sha384-old"></script>',
    );
    injectSri({ distDir: tmpDir, cdnAllowlist: [], refresh: true });
    const out = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8');
    expect(out).toBe(
      `<script src="main.js" integrity="${sri('x')}" crossorigin="anonymous"></script>`,
    );
  });

  it('keeps a stale integrity without refresh (default behaviour)', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.js'), 'x');
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<script src="main.js" integrity="sha384-old"></script>',
    );
    injectSri({ distDir: tmpDir, cdnAllowlist: [] });
    expect(fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8')).toContain('sha384-old');
  });
});

describe('injectSri refresh with an unresolvable local url', () => {
  it('fails instead of keeping a stale integrity', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-sri-u-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'index.html'),
        '<script src="/app/main.js" integrity="sha384-old"></script>',
      );
      expect(() => injectSri({ distDir: tmpDir, cdnAllowlist: [], refresh: true })).toThrow(
        /integrity for \/app\/main\.js/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
