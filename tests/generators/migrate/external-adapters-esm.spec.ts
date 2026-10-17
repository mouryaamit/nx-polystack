import * as path from 'path';

import {
  loadExternalAdapters,
  pathsResolver,
} from '../../../src/generators/migrate/adapters/external';
import { MIGRATE_API_VERSION } from '../../../src/migrate-sdk';

import { put, putJson, tmpSource } from './helpers';

/** An adapter object literal (no SDK import: these modules load through Node itself). */
const adapter = (id: string, label = "'test'") =>
  `{ apiVersion: ${MIGRATE_API_VERSION}, id: '${id}', label: ${label}, ` +
  "detect: () => ({ confidence: 0, reasons: [] }), defaultName: () => 'x', migrate: () => ({}) }";

const load = (root: string, entries: string[]) =>
  loadExternalAdapters(root, { pstack: { migrateAdapters: entries } });

describe('external adapters: ESM, .mts/.cts and tsconfig paths (NX-63)', () => {
  it('loads an .mjs adapter and a .js adapter in a "type": "module" folder', () => {
    const root = tmpSource();
    put(root, 'tools/a.mjs', `export default ${adapter('esm-mjs', "'mjs'")};\n`);
    putJson(root, 'tools/esm/package.json', { type: 'module' });
    put(root, 'tools/esm/b.js', `export const adapter = ${adapter('esm-js', "'js'")};\n`);
    expect(load(root, ['./tools/a.mjs', './tools/esm/b.js']).map((a) => a.id)).toEqual([
      'esm-mjs',
      'esm-js',
    ]);
  });

  it('finds an entry by trying .mts / .mjs when the extension is left out', () => {
    const root = tmpSource();
    put(root, 'tools/c.mjs', `export default ${adapter('no-ext')};\n`);
    expect(load(root, ['./tools/c']).map((a) => a.id)).toEqual(['no-ext']);
  });

  it('loads an ESM-only package through its exports', () => {
    const root = tmpSource();
    putJson(root, 'node_modules/@acme/esm-adapter/package.json', {
      name: '@acme/esm-adapter',
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    });
    put(
      root,
      'node_modules/@acme/esm-adapter/dist/index.js',
      `export default [${adapter('pkg-esm')}];\n`,
    );
    expect(load(root, ['@acme/esm-adapter']).map((a) => a.id)).toEqual(['pkg-esm']);
  });

  it('resolves an ESM-only package subpath through an exports pattern', () => {
    const root = tmpSource();
    putJson(root, 'node_modules/esm-kit/package.json', {
      name: 'esm-kit',
      type: 'module',
      exports: { './adapters/*': { import: './dist/*.js' } },
    });
    put(root, 'node_modules/esm-kit/dist/site.js', `export default ${adapter('pattern')};\n`);
    expect(load(root, ['esm-kit/adapters/site']).map((a) => a.id)).toEqual(['pattern']);
  });

  it('transpiles .mts and .cts adapters, resolving tsconfig paths from them', () => {
    const root = tmpSource();
    putJson(root, 'tsconfig.base.json', {
      compilerOptions: { baseUrl: '.', paths: { '@tools/*': ['tools/lib/*'] } },
    });
    put(root, 'tools/lib/labels.ts', "export const LABEL: string = 'from paths';\n");
    put(
      root,
      'tools/m.mts',
      "import { LABEL } from '@tools/labels';\n" +
        `const a: { id: string } = ${adapter('typed-mts', 'LABEL')};\nexport default a;\n`,
    );
    put(
      root,
      'tools/c.cts',
      `const b: Record<string, unknown> = ${adapter('typed-cts')};\nexport = b;\n`,
    );
    const loaded = load(root, ['./tools/m.mts', './tools/c.cts']);
    expect(loaded.map((a) => [a.id, a.label])).toEqual([
      ['typed-mts', 'from paths'],
      ['typed-cts', 'test'],
    ]);
  });

  it('explains top-level await', () => {
    const root = tmpSource();
    put(root, 'tools/tla.mjs', `await Promise.resolve();\nexport default ${adapter('tla')};\n`);
    expect(() => load(root, ['./tools/tla.mjs'])).toThrow(/top-level await/);
  });

  it('pathsResolver: exact keys, wildcards (longest prefix first), relative requests ignored', () => {
    const root = tmpSource();
    const r = pathsResolver(
      {
        baseUrl: root,
        paths: {
          '@a/*': ['libs/a/*', 'fallback/*'],
          '@a/special/*': ['special/*'],
          exact: ['x/index.ts'],
        },
      },
      root,
    );
    expect(r('@a/one')).toEqual([path.join(root, 'libs/a/one'), path.join(root, 'fallback/one')]);
    expect(r('@a/special/two')).toEqual([path.join(root, 'special/two')]);
    expect(r('exact')).toEqual([path.join(root, 'x/index.ts')]);
    expect(r('exact/more')).toBeUndefined();
    expect(r('./local')).toBeUndefined();
    expect(r('lodash')).toBeUndefined();
  });
});
