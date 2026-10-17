import * as fs from 'fs';
import * as path from 'path';

import { logger, parseJson, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrateGenerator from '../../../src/generators/migrate/generator';
import { rewriteImports } from '../../../src/generators/migrate/imports/rewrite';

import { fixtureCopy, put, putJson, readJsonFile, tmpSource } from './helpers';

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({ name: '@ws/root', scripts: {}, devDependencies: { nx: '~17.0.6' } }),
  );
  tree.write(
    'tsconfig.base.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {} } }),
  );
  // An Nx root file: a relative import of it from the source still resolves in the workspace.
  tree.write('jest.preset.js', 'module.exports = {};\n');
  return tree;
}

function treeState(tree: Tree, dir = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of tree.children(dir)) {
    const p = dir ? `${dir}/${child}` : child;
    if (tree.isFile(p)) {
      const text = tree.read(p, 'utf-8') as string;
      out[p] = p.endsWith('.json') ? parseJson(text) : text;
    } else Object.assign(out, treeState(tree, p));
  }
  return out;
}

const CROSS = [
  "import { greet } from '../../../utils/src';",
  "export * from '../../../utils/src/index';",
  "import { deep } from '../../../utils/src/greet';",
  "const lazy = () => import('../../../utils/src/greet');",
  "const req = require('../../../utils/src/greet');",
  "jest.mock('../../../utils/src/greet');",
  "import { local } from './local';",
  "import { shared } from '../../../../shared/thing';",
  "import { x } from '@acme/utils/src/greet';",
  '',
].join('\n');

/** The npm-workspace fixture with imports between its packages. */
function crossSource(): string {
  const src = fixtureCopy('npm-workspace');
  put(src, 'packages/web/src/app/feature.ts', CROSS);
  put(src, 'packages/web/src/app/local.ts', 'export const local = 1;\n');
  put(src, 'packages/utils/styles/_theme.scss', '$brand: red;\n');
  put(
    src,
    'packages/web/src/app/feature.scss',
    "@use '../../../utils/styles/theme' as t;\n@import 'plain', '../../../utils/styles/theme';\n" +
      "@use '~some/package';\n.a { color: t.$brand; }\n",
  );
  return src;
}

describe('import rewriting', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('rewrites relative imports into another moved package: the alias at its entry, else a new path', async () => {
    const tree = workspace();
    await migrateGenerator(tree, { source: crossSource() });
    expect(tree.read('apps/web/src/app/feature.ts', 'utf8')).toBe(
      [
        "import { greet } from '@acme/utils';",
        "export * from '@acme/utils';",
        "import { deep } from '../../../../libs/utils/src/greet';",
        "const lazy = () => import('../../../../libs/utils/src/greet');",
        "const req = require('../../../../libs/utils/src/greet');",
        "jest.mock('../../../../libs/utils/src/greet');",
        "import { local } from './local';",
        "import { shared } from '../../../../shared/thing';",
        "import { x } from '@acme/utils/src/greet';",
        '',
      ].join('\n'),
    );
    expect(tree.read('apps/web/src/app/feature.scss', 'utf8')).toBe(
      "@use '../../../../libs/utils/styles/theme' as t;\n" +
        "@import 'plain', '../../../../libs/utils/styles/theme';\n" +
        "@use '~some/package';\n.a { color: t.$brand; }\n",
    );
    // Subpath imports of a library package resolve through an added <package>/* alias.
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/utils/*']).toEqual([
      'libs/utils/*',
    ]);

    const report = tree.read('docs/migrations/acme-mono.md', 'utf8') as string;
    expect(report).toContain('## Imports');
    expect(report).toContain('Rewrote 4 imports in 2 copied files (the source was not changed):');
    expect(report).toMatch(
      /\| `apps\/web\/src\/app\/feature\.ts` +\| into another moved project \| `\.\.\/\.\.\/\.\.\/utils\/src` +\| `@acme\/utils` +\|/,
    );
    expect(report).toContain(
      '- `apps/web/src/app/feature.ts`: `../../../../libs/utils/src/greet`\n\n',
    );
    expect(report).toContain(
      "These imports reach below another project's entry and now use a relative path",
    );
    expect(report).toContain(
      '`apps/web/src/app/feature.ts`: `../../../../shared/thing` (points outside the imported projects)',
    );
    expect(report).toContain('They resolve through the added `@acme/utils/*` alias');
  });

  it('--no-rewrite-imports leaves the copies as they were', async () => {
    const tree = workspace();
    await migrateGenerator(tree, { source: crossSource(), rewriteImports: false });
    expect(tree.read('apps/web/src/app/feature.ts', 'utf8')).toBe(CROSS);
    const report = tree.read('docs/migrations/acme-mono.md', 'utf8') as string;
    expect(report).not.toContain('## Imports');
    expect(report).toContain('add a `<package>/*` alias to tsconfig.base.json');
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/utils/*']).toBe(
      undefined,
    );
  });

  it('rolls back the rewritten copies and the added alias', async () => {
    const tree = workspace();
    const before = treeState(tree);
    await migrateGenerator(tree, { source: crossSource() });
    await migrateGenerator(tree, { rollback: 'acme-mono' });
    expect(treeState(tree)).toEqual(before);
  });

  it('keeps imports that still resolve at the same paths (Nx sources)', async () => {
    const src = fixtureCopy('nx16-workspace');
    const text = "import { x } from '../../../../libs/shared/util/src/index';\n";
    put(src, 'apps/admin/src/app/cross.ts', text);
    const tree = workspace();
    await migrateGenerator(tree, { source: src, projects: 'admin' });
    expect(tree.read('apps/admin/src/app/cross.ts', 'utf8')).toBe(text);
    expect(tree.read('docs/migrations/source.md', 'utf8')).toContain(
      'No imports needed rewriting.',
    );
  });

  describe('rewriteImports()', () => {
    /**
     * A source with an app/ folder copied to apps/a: every file under app/ (except `skip`) is
     * copied as it is in the source, then `files` are written over it.
     */
    const run = (
      setup: (src: string) => void,
      files: Record<string, string>,
      skip: string[] = [],
    ) => {
      const src = tmpSource();
      setup(src);
      for (const [f, t] of Object.entries(files)) put(src, `app/${f}`, t);
      const tree = workspace();
      const copied: string[] = [];
      const walk = (rel: string) => {
        const abs = path.join(src, 'app', rel);
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(r);
          else if (!skip.includes(r)) {
            tree.write(`apps/a/${r}`, fs.readFileSync(path.join(abs, e.name)));
            copied.push(r);
          }
        }
      };
      if (fs.existsSync(path.join(src, 'app'))) walk('');
      const result = rewriteImports(tree, {
        sourceDir: src,
        moves: [{ from: path.join(src, 'app'), to: 'apps/a', files: copied }],
      });
      return { tree, result };
    };

    it('follows tsconfig extends for baseUrl, skips paths aliases and packages', () => {
      const { tree, result } = run(
        (src) => {
          putJson(src, 'tsconfig.base.json', {
            compilerOptions: { baseUrl: '.', paths: { 'app/legacy/*': ['old/*'] } },
          });
          putJson(src, 'app/tsconfig.json', { extends: '../tsconfig.base.json' });
          put(src, 'app/src/util.ts', '');
          put(src, 'app/legacy/x.ts', '');
        },
        {
          'src/main.ts': [
            "import { u } from 'app/src/util';",
            "import { l } from 'app/legacy/x';",
            "import { of } from 'rxjs';",
            "import { n } from 'app/src/missing';",
            '',
          ].join('\n'),
        },
      );
      expect(tree.read('apps/a/src/main.ts', 'utf8')).toBe(
        [
          "import { u } from './util';",
          "import { l } from 'app/legacy/x';",
          "import { of } from 'rxjs';",
          "import { n } from 'app/src/missing';",
          '',
        ].join('\n'),
      );
      expect(result.rewritten).toEqual([
        { file: 'apps/a/src/main.ts', kind: 'base-url', before: 'app/src/util', after: './util' },
      ]);
    });

    it('leaves a baseUrl import that the workspace baseUrl still resolves', () => {
      const { tree, result } = run(
        (src) => {
          putJson(src, 'tsconfig.json', { compilerOptions: { baseUrl: '.' } });
          put(src, 'app/src/util.ts', '');
        },
        { 'src/main.ts': "import { u } from 'apps/a/src/util';\n" },
      );
      // 'apps/a/src/util' does not exist in the source: not a baseUrl import at all.
      expect(tree.read('apps/a/src/main.ts', 'utf8')).toBe(
        "import { u } from 'apps/a/src/util';\n",
      );
      expect(result.rewritten).toEqual([]);
    });

    it('reports a baseUrl import of a file that was not imported, and @nrwl packages without @nx twin', () => {
      const { tree, result } = run(
        (src) => {
          putJson(src, 'tsconfig.json', { compilerOptions: { baseUrl: '.' } });
          put(src, 'other/thing.ts', '');
        },
        {
          'src/main.ts':
            "import { t } from 'other/thing';\nimport { c } from '@nrwl/nx-cloud';\n" +
            "import { d } from '@nrwl/devkit/testing';\n",
        },
      );
      expect(tree.read('apps/a/src/main.ts', 'utf8')).toBe(
        "import { t } from 'other/thing';\nimport { c } from '@nrwl/nx-cloud';\n" +
          "import { d } from '@nx/devkit/testing';\n",
      );
      expect(result.unresolved).toEqual([
        {
          file: 'apps/a/src/main.ts',
          spec: 'other/thing',
          why: 'resolves through the source `baseUrl` to a file that was not imported',
        },
        {
          file: 'apps/a/src/main.ts',
          spec: '@nrwl/nx-cloud',
          why: 'no `@nx/*` successor; replace it by hand',
        },
      ]);
    });

    it('does not take a package for a baseUrl folder without an index (cypress/)', () => {
      const { tree, result } = run(
        (src) => {
          putJson(src, 'app/tsconfig.json', { compilerOptions: { baseUrl: './' } });
          put(src, 'app/cypress/e2e/spec.cy.ts', '');
          put(src, 'app/lodash/index.ts', '');
          putJson(src, 'package.json', { devDependencies: { lodash: '4' } });
        },
        {
          'cypress.config.ts': "import { defineConfig } from 'cypress';\nimport l from 'lodash';\n",
        },
      );
      expect(tree.read('apps/a/cypress.config.ts', 'utf8')).toBe(
        "import { defineConfig } from 'cypress';\nimport l from 'lodash';\n",
      );
      expect(result.rewritten).toEqual([]);
      // lodash is a dependency and a folder with an index under the baseUrl: TypeScript would
      // pick the folder, so it is listed instead of guessed.
      expect(result.unresolved).toEqual([
        {
          file: 'apps/a/cypress.config.ts',
          spec: 'lodash',
          why: 'names both a dependency and a file under the source `baseUrl`; check which one it means',
        },
      ]);
    });

    it('resolves .js specifiers of .ts files, keeps ?query suffixes, and is quiet inside a project', () => {
      const src = tmpSource();
      put(src, 'libs/u/src/greet.ts', '');
      put(src, 'libs/u/src/tpl.html', '');
      const text =
        "import { g } from '../../libs/u/src/greet.js';\n" +
        "import tpl from '../../libs/u/src/tpl.html?raw';\n" +
        "import { s } from './same.js';\n" +
        "// copied from '../old/thing'\n";
      put(src, 'app/src/main.ts', text);
      put(src, 'app/src/same.ts', '');
      const tree = workspace();
      tree.write('apps/a/src/main.ts', text);
      tree.write('apps/a/src/same.ts', '');
      tree.write('libs/u/src/greet.ts', '');
      tree.write('libs/u/src/tpl.html', '');
      const result = rewriteImports(tree, {
        sourceDir: src,
        moves: [
          { from: path.join(src, 'app'), to: 'apps/a', files: ['src/main.ts', 'src/same.ts'] },
          {
            from: path.join(src, 'libs/u'),
            to: 'libs/u',
            files: ['src/greet.ts', 'src/tpl.html'],
          },
        ],
      });
      expect(tree.read('apps/a/src/main.ts', 'utf8')).toBe(
        "import { g } from '../../../libs/u/src/greet.js';\n" +
          "import tpl from '../../../libs/u/src/tpl.html?raw';\n" +
          "import { s } from './same.js';\n" +
          "// copied from '../old/thing'\n",
      );
      expect(result.unresolved).toEqual([]);
    });

    it('lists imports of files inside a move that were not copied, keeps ones the workspace has', () => {
      const { tree, result } = run(
        (src) => {
          put(src, 'app/projects/other/src/b.ts', '');
          put(src, 'jest.preset.js', '');
        },
        {
          'src/main.ts':
            "import { b } from '../projects/other/src/b';\nconst p = require('../../../jest.preset.js');\n",
        },
        ['projects/other/src/b.ts'],
      );
      expect(tree.read('apps/a/src/main.ts', 'utf8')).toContain("'../projects/other/src/b'");
      expect(result.unresolved).toEqual([
        {
          file: 'apps/a/src/main.ts',
          spec: '../projects/other/src/b',
          why: 'points to a file that was not copied',
        },
      ]);
    });

    it('points SCSS imports of the source node_modules at the workspace node_modules', () => {
      const { tree, result } = run(() => undefined, {
        'src/styles.scss': "@import '../../node_modules/bootstrap/scss/bootstrap';\n",
      });
      expect(tree.read('apps/a/src/styles.scss', 'utf8')).toBe(
        "@import '../../../node_modules/bootstrap/scss/bootstrap';\n",
      );
      expect(result.rewritten[0].kind).toBe('node-modules');
    });

    it('maps @nrwl/nx-plugin to @nx/plugin and names @nx packages the workspace lacks', () => {
      const { tree, result } = run(() => undefined, {
        'src/a.ts':
          "import { x } from '@nrwl/nx-plugin/testing';\nimport { y } from '@nrwl/nx-plugin/testing';\n" +
          "vi.mock('@nrwl/devkit');\nimport { z } from '@nrwl/cli';\n",
      });
      expect(tree.read('apps/a/src/a.ts', 'utf8')).toBe(
        "import { x } from '@nx/plugin/testing';\nimport { y } from '@nx/plugin/testing';\n" +
          "vi.mock('@nx/devkit');\nimport { z } from '@nrwl/cli';\n",
      );
      expect(result.rewritten).toHaveLength(2);
      expect(result.missingPackages).toEqual(['@nx/devkit', '@nx/plugin']);
      expect(result.unresolved.map((u) => u.spec)).toEqual(['@nrwl/cli']);
    });

    it('skips .d.ts files and files of other kinds', () => {
      const { tree } = run(() => undefined, {
        'src/types.d.ts': "import x from '@nrwl/angular';\n",
        'src/readme.md': "import x from '@nrwl/angular';\n",
      });
      expect(tree.read('apps/a/src/types.d.ts', 'utf8')).toContain('@nrwl/angular');
      expect(tree.read('apps/a/src/readme.md', 'utf8')).toContain('@nrwl/angular');
    });
  });

  it('takes rewriteImports from a batch file', async () => {
    const dir = tmpSource();
    const src = crossSource();
    putJson(dir, 'batch.json', {
      defaults: { rewriteImports: false },
      migrations: [{ source: src }],
    });
    const tree = workspace();
    await migrateGenerator(tree, { config: path.join(dir, 'batch.json') });
    expect(tree.read('apps/web/src/app/feature.ts', 'utf8')).toBe(CROSS);
    putJson(dir, 'bad.json', { migrations: [{ source: src, rewriteImports: 'no' }] });
    await expect(
      migrateGenerator(workspace(), { config: path.join(dir, 'bad.json') }),
    ).rejects.toThrow('"rewriteImports" must be true or false');
    expect(readJsonFile(dir, 'batch.json')).toBeDefined();
  });
});
