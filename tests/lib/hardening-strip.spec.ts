import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  minifyFile,
  minifyOptions,
  stripCssComments,
  stripHtmlComments,
  stripOutput,
} from '../../src/lib/hardening/strip';

const repoRoot = path.resolve(__dirname, '../..');

// terser is a workspace devDependency, not bundled: the tests that run it need it installed.
let hasTerser = true;
try {
  require.resolve('terser', { paths: [repoRoot] });
} catch {
  hasTerser = false;
}
const withTerser = hasTerser ? describe : describe.skip;
const withoutTerser = hasTerser ? it.skip : it;

describe('stripOutput', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-strip-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  const JS = [
    '/*! keep-license */',
    '// a note',
    'console.log("x");',
    'console.debug("d");',
    'console.error("e");',
    'export const a = 1;',
  ].join('\n');

  it('does nothing when both steps are off', async () => {
    write('main.js', JS);
    const counts = await stripOutput(root, { stripComments: false, dropConsole: [], repoRoot });
    expect(counts).toEqual({ js: 0, css: 0, html: 0, notes: [] });
    expect(read('main.js')).toBe(JS);
  });

  it('strips css and served-root html comments without terser when there is no JS', async () => {
    const html =
      '<html><!-- note --><!--#include virtual="/x" --><!--[if IE]><p>ie</p><![endif]--></html>';
    write('index.html', html);
    write('sub/page.html', html);
    write('styles.css', 'a{}/* c */');
    write('assets/lib.js', 'x(); // assets are never read');
    const counts = await stripOutput(root, { stripComments: true, dropConsole: [], repoRoot });
    // No JS to process: terser is not needed.
    expect(counts).toEqual({ js: 0, css: 1, html: 1, notes: [] });
    expect(read('index.html')).toBe(
      '<html><!--#include virtual="/x" --><!--[if IE]><p>ie</p><![endif]--></html>',
    );
    expect(read('sub/page.html')).toBe(html);
  });

  it('resolves the root, so a trailing slash still finds the served-root html', async () => {
    write('index.html', '<p><!-- x --></p>');
    await stripOutput(root + path.sep, { stripComments: true, dropConsole: [], repoRoot });
    expect(read('index.html')).toBe('<p></p>');
  });

  it('leaves html alone for SSR hydration (index.csr.html or ngh), with a note', async () => {
    write('index.html', '<p><!-- x --></p>');
    write('index.csr.html', '<p><!-- x --></p>');
    const csr = await stripOutput(root, { stripComments: true, dropConsole: [], repoRoot });
    expect(csr.html).toBe(0);
    expect(read('index.html')).toBe('<p><!-- x --></p>');
    expect(csr.notes).toEqual([expect.stringMatching(/index\.csr\.html.*hydration/)]);

    fs.rmSync(path.join(root, 'index.csr.html'));
    write('index.html', '<app-root ngh="0"><!--ngetn--></app-root>');
    const ngh = await stripOutput(root, { stripComments: true, dropConsole: [], repoRoot });
    expect(ngh.html).toBe(0);
    expect(read('index.html')).toContain('<!--ngetn-->');
    expect(ngh.notes).toEqual([expect.stringMatching(/index\.html.*ngh.*hydration/)]);
  });

  withoutTerser('fails asking for terser when the workspace does not have it', async () => {
    write('main.js', JS);
    await expect(
      stripOutput(root, { stripComments: true, dropConsole: [], repoRoot: root }),
    ).rejects.toThrow('stripComments/dropConsole need terser in the workspace devDependencies');
  });

  withTerser('with terser', () => {
    it('drops the listed console calls and keeps the others', async () => {
      write('main.js', JS);
      await stripOutput(root, { stripComments: false, dropConsole: ['log', 'debug'], repoRoot });
      const out = read('main.js');
      expect(out).not.toMatch(/console\.(log|debug)/);
      expect(out).toContain('console.error("e")');
      // Only console removal: the license comment stays, as Angular leaves it.
      expect(out).toContain('keep-license');
      expect(out).not.toContain('a note');
    });

    it('strips every comment from js, mjs and css, leaving assets alone', async () => {
      write('main.js', JS);
      write('chunk.mjs', '/*! lic */\nexport const b = 2; // tail');
      write('styles.css', '/*! lic */ a { content: "/* not a comment */"; } /* c */');
      write('assets/lib.js', JS);
      write('assets/x.css', '/* c */');
      const counts = await stripOutput(root, { stripComments: true, dropConsole: [], repoRoot });
      expect(counts).toEqual({ js: 2, css: 1, html: 0, notes: [] });
      expect(read('main.js')).not.toMatch(/keep-license|a note/);
      expect(read('main.js')).toContain('console.log("x")');
      expect(read('chunk.mjs')).not.toMatch(/lic|tail/);
      expect(read('chunk.mjs')).toContain('export');
      expect(read('styles.css')).toBe(' a { content: "/* not a comment */"; } ');
      expect(read('assets/lib.js')).toBe(JS);
      expect(read('assets/x.css')).toBe('/* c */');
    });

    it('fails naming the file terser cannot parse', async () => {
      write('broken.js', 'const = ;');
      await expect(
        stripOutput(root, { stripComments: true, dropConsole: [], repoRoot }),
      ).rejects.toThrow(/^broken\.js: terser could not parse it/);
    });
  });
});

describe('comment strippers', () => {
  it('keeps comment markers inside css strings, escapes included', () => {
    expect(stripCssComments(`a{b:'it\\'s /* x */'}/* gone */`)).toBe(`a{b:'it\\'s /* x */'}`);
  });

  it('removes an unterminated css comment to the end', () => {
    expect(stripCssComments('a{}/* open')).toBe('a{}');
  });

  it('removes plain html comments only', () => {
    expect(stripHtmlComments('<a><!--x\ny--></a><!--<![endif]-->')).toBe('<a></a><!--<![endif]-->');
  });

  it('copies unquoted url(...) through unchanged', () => {
    const css = 'a{background:url(data:image/svg+xml,<svg>/*x*/</svg>)}/* gone */';
    expect(stripCssComments(css)).toBe('a{background:url(data:image/svg+xml,<svg>/*x*/</svg>)}');
    expect(stripCssComments('a{b:URL( "/*x*/" )}/*y*/')).toBe('a{b:URL( "/*x*/" )}');
  });
});

describe('minifyOptions', () => {
  const root = path.join(os.tmpdir(), 'dist');
  const o = { stripComments: true, dropConsole: ['log'], repoRoot };

  it('parses .mjs, top-level import/export and browser/ output as modules', () => {
    const module = (file: string, code: string, r = root) =>
      (minifyOptions(path.join(r, file), code, r, o) as { module: boolean }).module;
    expect(module('a.mjs', 'x()')).toBe(true);
    expect(module('a.js', 'x();\nexport { x };')).toBe(true);
    expect(module('a.js', '  import "y";')).toBe(true);
    expect(module('a.js', 'const imported = 1; f("export")')).toBe(false);
    expect(module('a.js', 'x()', path.join(root, 'browser'))).toBe(true);
  });

  it('writes ASCII only and drops just the listed console methods', () => {
    expect(minifyOptions(path.join(root, 'a.js'), 'x()', root, o)).toMatchObject({
      mangle: false,
      compress: { defaults: false, pure_funcs: ['console.log'], side_effects: true },
      format: { comments: false, ascii_only: true },
    });
    expect(
      minifyOptions(path.join(root, 'a.js'), 'x()', root, {
        ...o,
        dropConsole: [],
        stripComments: false,
      }),
    ).toMatchObject({ compress: false, format: { comments: 'some', ascii_only: true } });
  });
});

describe('minifyFile', () => {
  const root = path.join(os.tmpdir(), 'dist');
  const o = { stripComments: true, dropConsole: [], repoRoot };
  const fake = (fail: (opts: { module: boolean }) => boolean) => ({
    minify: jest.fn(async (code: string, opts: object) => {
      if (fail(opts as { module: boolean })) throw new Error('Unexpected token');
      return { code: `/*${(opts as { module: boolean }).module}*/${code}` };
    }),
  });

  it('retries a module that does not parse as a script', async () => {
    const terser = fake((opts) => opts.module);
    const out = await minifyFile(terser, 'export x', path.join(root, 'a.js'), root, o);
    expect(out).toBe('/*false*/export x');
    expect(terser.minify).toHaveBeenCalledTimes(2);
  });

  it('fails naming the file when neither parses', async () => {
    const terser = fake(() => true);
    await expect(
      minifyFile(terser, 'export x', path.join(root, 'lib', 'a.js'), root, o),
    ).rejects.toThrow(`${path.join('lib', 'a.js')}: terser could not parse it (Unexpected token)`);
    expect(terser.minify).toHaveBeenCalledTimes(2);
  });

  it('does not retry a script', async () => {
    const terser = fake(() => true);
    await expect(minifyFile(terser, 'x', path.join(root, 'a.js'), root, o)).rejects.toThrow(
      /terser could not parse it/,
    );
    expect(terser.minify).toHaveBeenCalledTimes(1);
  });
});
