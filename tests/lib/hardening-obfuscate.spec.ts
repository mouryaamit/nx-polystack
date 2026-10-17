import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DECRYPT_MARKER,
  isSkippedChunk,
  loadObfuscator,
  obfuscateOutput,
  Obfuscator,
  obfuscatorOptions,
} from '../../src/lib/hardening/obfuscate';

const repoRoot = path.resolve(__dirname, '../..');

// javascript-obfuscator is a workspace devDependency, not bundled: the tests that run it need it.
let hasObfuscator = true;
try {
  require.resolve('javascript-obfuscator', { paths: [repoRoot] });
} catch {
  hasObfuscator = false;
}
const withObfuscator = hasObfuscator ? describe : describe.skip;

/** Records each call and wraps the code so a rewrite is visible. */
function fakeObfuscator(fail?: (code: string) => boolean) {
  const calls: { code: string; options: Record<string, unknown> }[] = [];
  const obfuscator: Obfuscator = {
    obfuscate(code, options) {
      calls.push({ code, options: options as Record<string, unknown> });
      if (fail?.(code)) throw new Error('Unexpected token');
      return { getObfuscatedCode: () => `/*o*/${code}` };
    },
  };
  return { obfuscator, calls };
}

describe('isSkippedChunk', () => {
  it.each([
    'runtime.js',
    'runtime.1a2b3c4d5e6f7a8b.js',
    'polyfills.0f1e2d3c4b5a6978.js',
    'vendor.abc123.js',
    'scripts.abc123.js',
    'styles.abc123.js',
    'polyfills-ABCD1234.js',
    'scripts-ABCD1234.js',
    'runtime.mjs',
    'polyfills-Q2W3E4R5.mjs',
  ])('skips %s', (name) => expect(isSkippedChunk(name)).toBe(true));

  it.each([
    'main.1a2b3c4d5e6f7a8b.js',
    'main-ABCD1234.js',
    'main.js',
    '123.4f5e6d7c8b9a0f1e.js',
    'chunk-ABCD1234.js',
    'src_app_feature_feature_module_ts.abc123.js',
    'runtime-helpers.abc.js',
  ])('obfuscates %s', (name) => expect(isSkippedChunk(name)).toBe(false));
});

describe('obfuscatorOptions', () => {
  const FIXED = {
    compact: true,
    renameGlobals: false,
    renameProperties: false,
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    sourceMap: false,
    target: 'browser-no-eval',
  };

  it('light: short names, half the strings, no wrappers', () => {
    expect(obfuscatorOptions('light', 'base', false)).toEqual({
      stringArray: true,
      stringArrayThreshold: 0.5,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayEncoding: [],
      stringArrayWrappersCount: 0,
      identifierNamesGenerator: 'mangled',
      transformObjectKeys: false,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      unicodeEscapeSequence: false,
      ...FIXED,
      sourceType: 'script',
    });
    // light and medium treat the decrypt chunk like any other.
    expect(obfuscatorOptions('light', 'decrypt', false)).toEqual(
      obfuscatorOptions('light', 'base', false),
    );
  });

  it('medium: hexadecimal names and three quarters of the strings', () => {
    const o = obfuscatorOptions('medium', 'decrypt', true);
    expect(o).toMatchObject({
      stringArrayThreshold: 0.75,
      identifierNamesGenerator: 'hexadecimal',
      stringArrayEncoding: [],
      controlFlowFlattening: false,
      sourceType: 'module',
    });
    expect(o.stringArrayWrappersCount).toBeUndefined();
  });

  it('strong: medium plus rc4 and light control-flow flattening on the decrypt chunk only', () => {
    expect(obfuscatorOptions('strong', 'base', false)).toEqual(
      obfuscatorOptions('medium', 'base', false),
    );
    expect(obfuscatorOptions('strong', 'decrypt', false)).toMatchObject({
      stringArrayEncoding: ['rc4'],
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.1,
    });
  });

  it('overrides apply on top of the preset; the CSP-safe settings always win', () => {
    const o = obfuscatorOptions('strong', 'decrypt', false, {
      stringArrayThreshold: 0.3,
      controlFlowFlattening: false,
      selfDefending: true,
      target: 'node',
    });
    expect(o).toMatchObject({
      stringArrayThreshold: 0.3,
      controlFlowFlattening: false,
      stringArrayEncoding: ['rc4'],
      ...FIXED,
    });
  });

  it('never sets options that need eval or lock the domain', () => {
    for (const mode of ['light', 'medium', 'strong'] as const) {
      for (const kind of ['base', 'decrypt'] as const) {
        const o = obfuscatorOptions(mode, kind, false);
        expect(o.domainLock).toBeUndefined();
        expect(o.debugProtectionInterval).toBeUndefined();
        expect(o.selfDefending).toBe(false);
        expect(o.target).toBe('browser-no-eval');
      }
    }
  });
});

describe('obfuscateOutput', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-obf-'));
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

  it('does nothing when off and never loads the obfuscator', async () => {
    write('main.abc.js', 'var a=1;');
    const result = await obfuscateOutput(root, { repoRoot: root, mode: 'off' });
    expect(result).toEqual({ files: 0, bytesBefore: 0, bytesAfter: 0 });
    expect(read('main.abc.js')).toBe('var a=1;');
  });

  it('does not load the obfuscator when there is nothing to obfuscate', async () => {
    write('runtime.abc.js', 'var r=1;');
    // repoRoot without javascript-obfuscator: loading would throw.
    const result = await obfuscateOutput(root, { repoRoot: root, mode: 'light' });
    expect(result.files).toBe(0);
  });

  it('obfuscates main and lazy chunks, skips the rest and assets/', async () => {
    write('main.abc.js', 'var m=1;');
    write('123.def.js', 'var l=1;');
    write('runtime.abc.js', 'var r=1;');
    write('polyfills.abc.js', 'var p=1;');
    write('assets/lib.js', 'var x=1;');
    const { obfuscator, calls } = fakeObfuscator();
    const result = await obfuscateOutput(root, { repoRoot: root, mode: 'light', obfuscator });

    expect(result.files).toBe(2);
    expect(result.bytesBefore).toBe(16);
    expect(result.bytesAfter).toBe(16 + 10);
    expect(read('main.abc.js')).toBe('/*o*/var m=1;');
    expect(read('123.def.js')).toBe('/*o*/var l=1;');
    expect(read('runtime.abc.js')).toBe('var r=1;');
    expect(read('polyfills.abc.js')).toBe('var p=1;');
    expect(read('assets/lib.js')).toBe('var x=1;');
    expect(calls.every((c) => c.options.identifierNamesGenerator === 'mangled')).toBe(true);
  });

  it('strong gives the chunk holding the env-secret runtime the decrypt profile', async () => {
    write('main.abc.js', `var info="${DECRYPT_MARKER}"+e;`);
    write('456.def.js', 'var l=1;');
    const { obfuscator, calls } = fakeObfuscator();
    await obfuscateOutput(root, { repoRoot: root, mode: 'strong', obfuscator });
    const byCode = new Map(calls.map((c) => [c.code, c.options]));
    expect(byCode.get(`var info="${DECRYPT_MARKER}"+e;`)?.stringArrayEncoding).toEqual(['rc4']);
    expect(byCode.get('var l=1;')?.stringArrayEncoding).toEqual([]);
  });

  it('uses the module source type for ES modules', async () => {
    write('main-ABCD.mjs', 'export const a=1;');
    write('chunk-EFGH.js', 'export const b=1;');
    write('legacy.abc.js', 'var c=1;');
    const { obfuscator, calls } = fakeObfuscator();
    await obfuscateOutput(root, { repoRoot: root, mode: 'light', obfuscator });
    const byCode = new Map(calls.map((c) => [c.code, c.options.sourceType]));
    expect(byCode.get('export const a=1;')).toBe('module');
    expect(byCode.get('export const b=1;')).toBe('module');
    expect(byCode.get('var c=1;')).toBe('script');
  });

  it('gives every file its own identifier prefix and a content seed', async () => {
    write('main.abc.js', 'var m=1;');
    write('1.def.js', 'var l=1;');
    const { obfuscator, calls } = fakeObfuscator();
    await obfuscateOutput(root, { repoRoot: root, mode: 'light', obfuscator });
    const prefixes = calls.map((c) => c.options.identifiersPrefix as string);
    expect(prefixes.every((p) => /^_p[0-9a-f]{6}$/.test(p))).toBe(true);
    expect(new Set(prefixes).size).toBe(2);
    expect(calls.every((c) => Number.isInteger(c.options.seed))).toBe(true);
  });

  it('passes the overrides to every file', async () => {
    write('main.abc.js', 'var m=1;');
    const { obfuscator, calls } = fakeObfuscator();
    await obfuscateOutput(root, {
      repoRoot: root,
      mode: 'light',
      overrides: { stringArrayThreshold: 0.2 },
      obfuscator,
    });
    expect(calls[0].options.stringArrayThreshold).toBe(0.2);
  });

  it('names the file the obfuscator rejects', async () => {
    write('sub/main.abc.js', 'var a=;');
    const { obfuscator } = fakeObfuscator(() => true);
    await expect(
      obfuscateOutput(root, { repoRoot: root, mode: 'light', obfuscator }),
    ).rejects.toThrow(`obfuscate: ${path.join('sub', 'main.abc.js')}: Unexpected token`);
  });
});

describe('loadObfuscator', () => {
  it('names the package when the workspace does not have it', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-noobf-'));
    try {
      expect(() => loadObfuscator(empty)).toThrow(
        'obfuscate: add javascript-obfuscator to devDependencies (npm i -D javascript-obfuscator@4)',
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

withObfuscator('obfuscateOutput with javascript-obfuscator', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-obf-real-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('produces code that still runs and hides the string literals', async () => {
    const code = 'var greeting = "hello-from-the-app"; globalThis.__out = greeting.toUpperCase();';
    fs.writeFileSync(path.join(root, 'main.abc.js'), code);
    await obfuscateOutput(root, { repoRoot, mode: 'light' });
    const out = fs.readFileSync(path.join(root, 'main.abc.js'), 'utf8');
    expect(out).not.toBe(code);
    // eslint-disable-next-line no-new-func
    new Function(out)();
    expect((globalThis as Record<string, unknown>).__out).toBe('HELLO-FROM-THE-APP');
    delete (globalThis as Record<string, unknown>).__out;
  });

  it.each(['medium', 'strong'] as const)('%s output still runs', async (mode) => {
    const code = `var info = "${DECRYPT_MARKER}x"; globalThis.__lvl = [info.length, "level-check"].join(":");`;
    fs.writeFileSync(path.join(root, 'main.abc.js'), code);
    await obfuscateOutput(root, { repoRoot, mode });
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(path.join(root, 'main.abc.js'), 'utf8'))();
    expect((globalThis as Record<string, unknown>).__lvl).toBe('15:level-check');
    delete (globalThis as Record<string, unknown>).__lvl;
  });

  it('keeps ES module syntax working for module chunks', async () => {
    fs.writeFileSync(
      path.join(root, 'chunk-ABCD.mjs'),
      'export const label = "chunk-label"; export function f(){ return label; }',
    );
    await obfuscateOutput(root, { repoRoot, mode: 'light' });
    const out = fs.readFileSync(path.join(root, 'chunk-ABCD.mjs'), 'utf8');
    // The exported names survive renaming.
    expect(out).toMatch(/\bas label\b|export const label\b/);
    expect(out).toMatch(/\bas f\b|export function f\b/);
  });

  it("keeps two classic-script chunks from overwriting each other's globals", async () => {
    fs.writeFileSync(
      path.join(root, '1.a.js'),
      'globalThis.__a = ["one-string", "two"].join("-");',
    );
    fs.writeFileSync(
      path.join(root, '2.b.js'),
      'globalThis.__b = ["three-string", "four"].join("-");',
    );
    await obfuscateOutput(root, { repoRoot, mode: 'light' });
    const g = globalThis as Record<string, unknown>;
    // Both run in one global scope, like two <script> tags.
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(path.join(root, '1.a.js'), 'utf8'))();
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(path.join(root, '2.b.js'), 'utf8'))();
    expect([g.__a, g.__b]).toEqual(['one-string-two', 'three-string-four']);
    delete g.__a;
    delete g.__b;
  });
});
