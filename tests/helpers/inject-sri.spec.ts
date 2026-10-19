import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { injectCspNonce, NONCE_SSI_PLACEHOLDER } from '../../src/lib/helpers/inject-nonce';
import { injectSri } from '../../src/lib/helpers/inject-sri';
import { scanTags } from '../../src/lib/html/tags';

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

describe('injectSri with nonce placeholders and assets', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-sri-n-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, rel), text);
  };
  const read = (rel: string) => fs.readFileSync(path.join(tmpDir, rel), 'utf8');

  it('after the nonce: integrity outside the SSI directive, same tags, no double spaces', () => {
    write('main.js', 'main');
    write('styles.css', 'a{}');
    write(
      'index.html',
      '<html><head><link rel="stylesheet" href="styles.css"></head>' +
        '<body><script  src="main.js" type="module"></script><script>boot()</script></body></html>',
    );
    injectCspNonce({ distDir: tmpDir });
    const before = scanTags(read('index.html'));
    injectSri({ distDir: tmpDir, cdnAllowlist: [] });
    const html = read('index.html');
    const after = scanTags(html);

    expect(after.map((t) => t.name)).toEqual(before.map((t) => t.name));
    after.forEach((tag, i) => {
      const names = tag.attrs
        .map((a) => a.name)
        .filter((n) => !/^(integrity|crossorigin)$/.test(n));
      expect(names).toEqual(before[i].attrs.map((a) => a.name));
    });
    // Every SSI directive is intact: nothing was written inside one.
    expect(html.match(/<!--#[^>]*-->/g)).toEqual(Array(4).fill(NONCE_SSI_PLACEHOLDER));
    const script = after.find((t) => t.attrs.some((a) => a.value === 'main.js'));
    expect(script?.attrs.map((a) => a.name)).toEqual([
      'src',
      'integrity',
      'crossorigin',
      'type',
      'nonce',
    ]);
    // The tag kept its own spacing; nothing new added a second space.
    expect(html).toContain('<script  src="main.js" integrity="sha384-');
    expect(html.replace('<script  src', '')).not.toMatch(/<[a-z]+[^>]* {2}/);
  });

  it('never touches pages under assets/', () => {
    write('main.js', 'main');
    const page =
      `<script src="../main.js" nonce="${NONCE_SSI_PLACEHOLDER}"></script>` +
      '<link rel="stylesheet" href="x.css">';
    write('assets/togetherjs/a.html', page);
    write('assets/x.css', 'a{}');
    write('index.html', '<script src="main.js"></script>');
    injectSri({ distDir: tmpDir, cdnAllowlist: [] });
    expect(read('assets/togetherjs/a.html')).toBe(page);
    expect(read('index.html')).toContain('integrity=');
    expect(() =>
      injectSri({ distDir: tmpDir, cdnAllowlist: [], files: ['assets/togetherjs/a.html'] }),
    ).toThrow(/under assets/);
    expect(() => injectSri({ distDir: tmpDir, cdnAllowlist: [], files: ['../x.html'] })).toThrow(
      /files/,
    );
  });
});

describe('scanTags', () => {
  it('keeps a > inside quotes and SSI directives within the tag', () => {
    const html =
      '<script nonce="<!--#echo var="CSP_NONCE" -->" data-x="a>b">if (a > b) {}</script>' +
      "<link nonce='<!--#echo var='UNIQUE_ID' -->' href=x.css><!-- <p> --><p>";
    const tags = scanTags(html);
    expect(tags.map((t) => t.name)).toEqual(['script', 'link', 'p']);
    expect(tags[0].attrs.map((a) => [a.name, a.value])).toEqual([
      ['nonce', '<!--#echo var="CSP_NONCE" -->'],
      ['data-x', 'a>b'],
    ]);
    expect(tags[1].attrs.map((a) => [a.name, a.value])).toEqual([
      ['nonce', "<!--#echo var='UNIQUE_ID' -->"],
      ['href', 'x.css'],
    ]);
  });
});
