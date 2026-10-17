import * as fs from 'fs';
import * as path from 'path';

import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import * as ts from 'typescript';

import { detectAll } from '../../../src/generators/migrate/adapters';
import {
  adapterEntries,
  loadExternalAdapters,
  parseNxJson,
  typeScriptHook,
} from '../../../src/generators/migrate/adapters/external';
import migrateGenerator from '../../../src/generators/migrate/generator';
import * as sdk from '../../../src/migrate-sdk';

import { fixtureCopy, put, tmpSource } from './helpers';

const SDK = path.resolve(__dirname, '../../../src/migrate-sdk');

/** A CommonJS adapter module on disk that imports the SDK from the source tree. */
function adapterFile(dir: string, file: string, body: string): string {
  const at = path.join(dir, file);
  put(dir, file, `const sdk = require(${JSON.stringify(SDK)});\n${body}\n`);
  return at;
}

const SITE_ADAPTER = `
module.exports = {
  apiVersion: sdk.MIGRATE_API_VERSION,
  id: 'static-site',
  label: 'static web site',
  detect(sourceDir) {
    return sdk.sourceExists(sourceDir, 'index.html')
      ? { confidence: 0.9, reasons: ['index.html'] }
      : { confidence: 0, reasons: ['no index.html'] };
  },
  defaultName: () => 'site',
  migrate(tree, ctx) {
    const data = sdk.emptyReportData();
    data.npmProject = false;
    const copy = sdk.copyIntoTree(tree, ctx.sourceDir, ctx.projectRoot, { anyDepth: ['.git'], topLevel: [] });
    sdk.recordCopy(data, copy, '');
    tree.write(ctx.projectRoot + '/project.json', JSON.stringify({ name: ctx.name, projectType: 'application' }));
    return data;
  },
};`;

function workspace(adapters?: string[]): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write('package.json', JSON.stringify({ name: '@ws/root', devDependencies: {} }));
  tree.write(
    'tsconfig.base.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {} } }),
  );
  if (adapters) {
    const nx = readJson(tree, 'nx.json');
    tree.write('nx.json', JSON.stringify({ ...nx, pstack: { migrateAdapters: adapters } }));
  }
  return tree;
}

function siteSource(): string {
  const src = tmpSource();
  put(src, 'index.html', '<h1>hi</h1>\n');
  put(src, 'css/site.css', 'h1 { color: red; }\n');
  return src;
}

describe('external migrate adapters (SDK)', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('exposes the contract and helpers', () => {
    expect(sdk.MIGRATE_API_VERSION).toBe(1);
    for (const fn of [
      'copyIntoTree',
      'recordCopy',
      'emptyReportData',
      'mergeDependencies',
      'classifyDependencySpec',
      'readSourceJson',
      'readSourceText',
      'sourceExists',
      'kebabName',
      'upTo',
      'setProjectTags',
      'defineMigrationAdapter',
    ] as const) {
      expect(typeof sdk[fn]).toBe('function');
    }
    const a = { apiVersion: 1, id: 'x', label: 'x' } as never;
    expect(sdk.defineMigrationAdapter(a)).toBe(a);
  });

  it('detects and migrates with a listed adapter: report, import rewriting and rollback included', async () => {
    const dir = tmpSource();
    const file = adapterFile(dir, 'site.adapter.js', SITE_ADAPTER);
    const tree = workspace([file]);
    const before = JSON.stringify(readJson(tree, 'nx.json'));
    await migrateGenerator(tree, { source: siteSource() });
    expect(tree.read('apps/site/index.html', 'utf8')).toContain('hi');
    expect(tree.exists('apps/site/css/site.css')).toBe(true);
    const report = tree.read('docs/migrations/site.md', 'utf8') as string;
    expect(report).toContain('- Adapter: `static-site` (static web site)');
    expect(report).toContain('## Imports');
    await migrateGenerator(tree, { rollback: 'site' });
    expect(tree.exists('apps/site')).toBe(false);
    expect(JSON.stringify(readJson(tree, 'nx.json'))).toBe(before);
  });

  it('comes after the built-ins: they win ties; --adapter and --config pick it by id', async () => {
    const dir = tmpSource();
    const greedy = adapterFile(
      dir,
      'greedy.js',
      SITE_ADAPTER.replace("'static-site'", "'greedy'")
        .replace("return sdk.sourceExists(sourceDir, 'index.html')", 'return true')
        .replace('confidence: 0.9', 'confidence: 1'),
    );
    const extra = loadExternalAdapters('/', { pstack: { migrateAdapters: [greedy] } });
    const rows = detectAll(fixtureCopy('angular15-app'), extra);
    expect(rows.slice(0, 2).map((r) => [r.adapter.id, r.confidence])).toEqual([
      ['angular-cli', 1],
      ['greedy', 1],
    ]);

    const file = adapterFile(dir, 'site.adapter.js', SITE_ADAPTER);
    const tree = workspace([file]);
    await migrateGenerator(tree, { source: siteSource(), adapter: 'static-site', name: 'forced' });
    expect(tree.exists('apps/forced/index.html')).toBe(true);
    const batch = path.join(dir, 'batch.json');
    fs.writeFileSync(
      batch,
      JSON.stringify({ migrations: [{ source: siteSource(), adapter: 'static-site', name: 'b' }] }),
    );
    await migrateGenerator(tree, { config: batch });
    expect(tree.exists('apps/b/index.html')).toBe(true);
  });

  it('scores an adapter whose detect() throws as 0 with the error', () => {
    const dir = tmpSource();
    const bad = adapterFile(
      dir,
      'bad.js',
      SITE_ADAPTER.replace("'static-site'", "'bad'").replace(
        'detect(sourceDir) {',
        "detect(sourceDir) { throw new Error('boom');",
      ),
    );
    const extra = loadExternalAdapters('/', { pstack: { migrateAdapters: [bad] } });
    const row = detectAll(tmpSource(), extra).find((r) => r.adapter.id === 'bad');
    expect(row).toMatchObject({
      confidence: 0,
      reasons: [`detect() failed: adapter "bad" (${bad}): boom`],
    });
  });

  it('refuses bad entries, naming them', () => {
    const dir = tmpSource();
    const load = (entry: string) =>
      loadExternalAdapters(dir, { pstack: { migrateAdapters: [entry] } });
    const variant = (name: string, from: string, to: string) =>
      adapterFile(dir, name, SITE_ADAPTER.replace(from, to));
    expect(() => adapterEntries({ pstack: { migrateAdapters: 'x' } })).toThrow(
      'pstack.migrateAdapters must be a list',
    );
    expect(adapterEntries(undefined)).toEqual([]);
    expect(() => load('./missing.js')).toThrow(
      'entry "./missing.js": no such file (looked for missing.js).',
    );
    expect(() => load('@nobody/pstack-adapter')).toThrow('the package is not installed');
    expect(() =>
      load(variant('v0.js', 'apiVersion: sdk.MIGRATE_API_VERSION', 'apiVersion: 2')),
    ).toThrow('declares apiVersion 2; this nx-polystack supports apiVersion 1');
    expect(() => load(variant('v1.js', 'apiVersion: sdk.MIGRATE_API_VERSION,', ''))).toThrow(
      'declares apiVersion undefined',
    );
    expect(() => load(variant('ng.js', "'static-site'", "'angular-cli'"))).toThrow(
      'adapter id "angular-cli" is already used by a built-in adapter.',
    );
    expect(() => load(variant('case.js', "'static-site'", "'Static'"))).toThrow(
      'adapter id "Static" must be kebab-case.',
    );
    expect(() => load(variant('nofn.js', 'migrate(tree, ctx) {', 'migrateX(tree, ctx) {'))).toThrow(
      'adapter "static-site" has no migrate() function.',
    );
    expect(() => load(adapterFile(dir, 'throws.js', "throw new Error('nope');"))).toThrow(
      'could not be loaded: nope',
    );
    const one = adapterFile(dir, 'one.js', SITE_ADAPTER);
    const two = adapterFile(dir, 'two.js', SITE_ADAPTER);
    expect(() => loadExternalAdapters(dir, { pstack: { migrateAdapters: [one, two] } })).toThrow(
      `adapter id "static-site" is already used by "${one}".`,
    );
  });

  it('names the adapter in its own errors, and a built-in --adapter skips a broken list', async () => {
    const dir = tmpSource();
    const failing = adapterFile(
      dir,
      'failing.js',
      SITE_ADAPTER.replace('const data = sdk.emptyReportData();', "throw new Error('kaboom');"),
    );
    await expect(
      migrateGenerator(workspace([failing]), { source: siteSource(), adapter: 'static-site' }),
    ).rejects.toThrow(`adapter "static-site" (${failing}): kaboom`);

    const broken = workspace(['./does-not-exist.js']);
    await expect(migrateGenerator(broken, { source: siteSource() })).rejects.toThrow(
      'no such file (looked for does-not-exist.js). Fix it, or remove the entry to migrate with the built-in adapters.',
    );
    await migrateGenerator(broken, {
      source: fixtureCopy('angular15-app'),
      adapter: 'angular-cli',
      name: 'portal',
    });
    expect(broken.exists('apps/portal/project.json')).toBe(true);

    // A batch of built-in adapters does not load the broken list either.
    const batch = path.join(dir, 'builtin.json');
    fs.writeFileSync(
      batch,
      JSON.stringify({
        migrations: [{ source: fixtureCopy('angular15-app'), adapter: 'angular-cli', name: 'two' }],
      }),
    );
    await migrateGenerator(broken, { config: batch });
    expect(broken.exists('apps/two/project.json')).toBe(true);

    expect(() => parseNxJson('{ nope')).toThrow('migrate: nx.json is not valid JSON (');
    expect(parseNxJson(null)).toBeUndefined();
    const notJson = workspace();
    notJson.write('nx.json', '{ nope');
    await expect(migrateGenerator(notJson, { source: siteSource() })).rejects.toThrow(
      'nx.json is not valid JSON',
    );
    expect(() =>
      loadExternalAdapters(dir, {
        pstack: {
          migrateAdapters: [
            adapterFile(
              dir,
              'pf.js',
              SITE_ADAPTER.replace("label: 'static web site',", "label: 'x', preflight: 'no',"),
            ),
          ],
        },
      }),
    ).toThrow('has a preflight that is not a function');
  });

  it('keeps class-instance adapters (prototype getters) intact', async () => {
    const dir = tmpSource();
    const cls = adapterFile(
      dir,
      'class.js',
      `${SITE_ADAPTER}
const plain = module.exports;
class SiteAdapter {
  get id() { return 'class-site'; }
  get label() { return 'class site'; }
  get apiVersion() { return 1; }
  detect(d) { return plain.detect(d); }
  defaultName() { return 'cls'; }
  migrate(t, c) { return plain.migrate(t, c); }
}
module.exports = new SiteAdapter();`,
    );
    const tree = workspace([cls]);
    await migrateGenerator(tree, { source: siteSource(), adapter: 'class-site' });
    expect(tree.read('docs/migrations/cls.md', 'utf8')).toContain('`class-site` (class site)');
  });

  it('keeps the SDK surface stable', () => {
    expect(Object.keys(sdk).sort()).toEqual([
      'DEFAULT_MAX_FILES',
      'MIGRATE_API_VERSION',
      'classifyDependencySpec',
      'copyIntoTree',
      'defineMigrationAdapter',
      'emptyReportData',
      'isPossibleSecret',
      'isSourceFile',
      'kebabName',
      'mergeDependencies',
      'readSourceJson',
      'readSourcePackageJson',
      'readSourceText',
      'recordCopy',
      'setProjectTags',
      'sourceDependency',
      'sourceExists',
      'upTo',
    ]);
  });

  it('takes an adapter list and the default export', () => {
    const dir = tmpSource();
    adapterFile(
      dir,
      'list.js',
      `${SITE_ADAPTER}\nconst a = module.exports;\nmodule.exports = { adapters: [a, { ...a, id: 'site-two' }] };`,
    );
    const dflt = adapterFile(
      dir,
      'default.js',
      `${SITE_ADAPTER}\nmodule.exports = { default: { ...module.exports, id: 'site-three' } };`,
    );
    expect(
      loadExternalAdapters(dir, { pstack: { migrateAdapters: ['./list.js', dflt] } }).map(
        (a) => a.id,
      ),
    ).toEqual(['static-site', 'site-two', 'site-three']);
  });

  it('transpiles TypeScript adapter files with the workspace typescript', () => {
    const dir = tmpSource();
    put(dir, 'a.ts', "export const id: string = 'typed';\nexport default { id };\n");
    let compiled = '';
    typeScriptHook(ts)({ _compile: (code: string) => (compiled = code) }, path.join(dir, 'a.ts'));
    expect(compiled).toContain("exports.id = 'typed'");
    expect(compiled).not.toContain(': string');
  });

  describe('--new-adapter', () => {
    it('writes a working starter adapter, its spec and jest config, and lists it in nx.json', async () => {
      const tree = workspace();
      await migrateGenerator(tree, { newAdapter: 'static-site' });
      const file = 'tools/migrate/static-site.adapter.ts';
      expect(readJson(tree, 'nx.json').pstack).toEqual({ migrateAdapters: [`./${file}`] });
      expect(tree.exists('tools/migrate/static-site.adapter.spec.ts')).toBe(true);
      expect(tree.read('tools/migrate/jest.config.js', 'utf8')).toContain(
        "'^.+\\\\.ts$': ['ts-jest'",
      );

      // The generated adapter works: import it with the SDK from the source tree.
      const dir = tmpSource();
      const source = (tree.read(file, 'utf8') as string).replace(
        "'@mouryaamit/nx-polystack/migrate'",
        JSON.stringify(SDK),
      );
      put(dir, 'static-site.adapter.ts', source);
      const ws = workspace([path.join(dir, 'static-site.adapter.ts')]);
      const src = siteSource();
      expect(
        detectAll(src, loadExternalAdapters(dir, readJson(ws, 'nx.json'))).find(
          (r) => r.adapter.id === 'static-site',
        )?.confidence,
      ).toBe(0.6);
      await migrateGenerator(ws, { source: src, adapter: 'static-site', name: 'site' });
      expect(readJson(ws, 'apps/site/project.json')).toMatchObject({
        name: 'site',
        projectType: 'application',
        tags: ['scope:app', 'type:app', 'platform:web'],
      });
      expect(ws.read('docs/migrations/site.md', 'utf8')).toContain(
        'Imported with the static-site starter adapter',
      );
    });

    it('refuses an existing file, a built-in id, a bad id and other options', async () => {
      const tree = workspace();
      await migrateGenerator(tree, { newAdapter: 'site' });
      await expect(migrateGenerator(tree, { newAdapter: 'site' })).rejects.toThrow(
        'tools/migrate/site.adapter.ts already exists.',
      );
      await expect(migrateGenerator(tree, { newAdapter: 'flutter' })).rejects.toThrow(
        'is the id of a built-in adapter',
      );
      await expect(migrateGenerator(tree, { newAdapter: 'Bad' })).rejects.toThrow(
        'must be kebab-case',
      );
      await expect(
        migrateGenerator(tree, { newAdapter: 'other', source: '../x', rewriteImports: true }),
      ).rejects.toThrow('it takes no other options (got source)');
      const bad = workspace();
      const nx = readJson(bad, 'nx.json');
      bad.write('nx.json', JSON.stringify({ ...nx, pstack: { migrateAdapters: 'x' } }));
      await expect(migrateGenerator(bad, { newAdapter: 'other' })).rejects.toThrow(
        'pstack.migrateAdapters must be a list',
      );
      const dir = tmpSource();
      const listed = workspace([adapterFile(dir, 'site.js', SITE_ADAPTER)]);
      await expect(migrateGenerator(listed, { newAdapter: 'static-site' })).rejects.toThrow(
        'is the id of an adapter nx.json already lists',
      );
      // A second adapter is appended to the list.
      await migrateGenerator(tree, { newAdapter: 'other' });
      expect(readJson(tree, 'nx.json').pstack.migrateAdapters).toEqual([
        './tools/migrate/site.adapter.ts',
        './tools/migrate/other.adapter.ts',
      ]);
    });
  });
});
