import * as fs from 'fs';
import * as path from 'path';

import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { ImportMove, rewriteImports } from '../../../src/generators/migrate/imports/rewrite';

import { put, putJson, tmpSource } from './helpers';

/**
 * A source with app/ copied to apps/a and lib/ copied to libs/l (every file as it is), then the
 * import pass over both. `extra` writes workspace files before the pass.
 */
function run(setup: (src: string) => void, extra: (tree: Tree) => void = () => undefined) {
  const src = tmpSource();
  setup(src);
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'tsconfig.base.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {} } }),
  );
  const moves: ImportMove[] = [];
  for (const [from, to] of [
    ['app', 'apps/a'],
    ['lib', 'libs/l'],
  ]) {
    const files: string[] = [];
    const walk = (rel: string) => {
      const abs = path.join(src, from, rel);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else {
          tree.write(`${to}/${r}`, fs.readFileSync(path.join(abs, e.name)));
          files.push(r);
        }
      }
    };
    walk('');
    moves.push({ from: path.join(src, from), to, files });
  }
  extra(tree);
  const result = rewriteImports(tree, { sourceDir: src, moves });
  return { tree, result };
}

describe('import rewriting: Angular resources (NX-60)', () => {
  it('rewrites templateUrl / styleUrl / styleUrls that reach into another copied folder', () => {
    const { tree, result } = run((src) => {
      put(src, 'app/src/app/a.component.html', '<p></p>');
      put(src, 'app/src/app/a.component.scss', '');
      put(src, 'lib/ui/shared.scss', '');
      put(src, 'lib/ui/card.html', '');
      put(
        src,
        'app/src/app/a.component.ts',
        [
          '@Component({',
          "  templateUrl: './a.component.html',",
          "  styleUrls: ['./a.component.scss', '../../../lib/ui/shared.scss'],",
          '})',
          'export class A {}',
          '@Component({ templateUrl: `../../../lib/ui/card.html`, styleUrl: "../../../lib/ui/shared.scss" })',
          'export class B {}',
          '',
        ].join('\n'),
      );
    });
    expect(tree.read('apps/a/src/app/a.component.ts', 'utf8')).toBe(
      [
        '@Component({',
        "  templateUrl: './a.component.html',",
        "  styleUrls: ['./a.component.scss', '../../../../libs/l/ui/shared.scss'],",
        '})',
        'export class A {}',
        '@Component({ templateUrl: `../../../../libs/l/ui/card.html`, styleUrl: "../../../../libs/l/ui/shared.scss" })',
        'export class B {}',
        '',
      ].join('\n'),
    );
    expect(result.rewritten.filter((r) => r.kind === 'resource')).toHaveLength(2);
    expect(result.deepImports).toEqual([]);
  });

  it('lists a resource that was not copied or is outside every move, and leaves it', () => {
    const { tree, result } = run((src) => {
      put(src, 'shared/outside.html', '');
      put(src, 'lib/ui/kept.html', '');
      put(
        src,
        'app/c.ts',
        "@Component({ templateUrl: '../shared/outside.html', styleUrls: ['../lib/ui/gone.scss'] })\n",
      );
    });
    expect(tree.read('apps/a/c.ts', 'utf8')).toContain("'../shared/outside.html'");
    expect(result.unresolved).toEqual([
      {
        file: 'apps/a/c.ts',
        spec: '../shared/outside.html',
        why: 'points outside the imported projects',
      },
      {
        file: 'apps/a/c.ts',
        spec: '../lib/ui/gone.scss',
        why: 'points to a file that was not copied',
      },
    ]);
  });
});

describe('import rewriting: Sass load paths (NX-61)', () => {
  const angular = (includePaths: string[]) => ({
    version: 1,
    projects: {
      a: {
        root: 'app',
        architect: {
          build: { options: { stylePreprocessorOptions: { includePaths } } },
        },
      },
    },
  });

  it('rewrites a bare path that resolved through a source load path into another copied folder', () => {
    const { tree, result } = run((src) => {
      putJson(src, 'angular.json', angular(['lib/styles']));
      put(src, 'lib/styles/_theme.scss', '$c: red;\n');
      put(
        src,
        'app/src/styles.scss',
        "@use 'theme' as t;\n@use 'sass:math';\n@import 'x.css';\n@use '~pkg/a';\n",
      );
    });
    expect(tree.read('apps/a/src/styles.scss', 'utf8')).toBe(
      "@use '../../../libs/l/styles/theme' as t;\n@use 'sass:math';\n@import 'x.css';\n@use '~pkg/a';\n",
    );
    expect(result.rewritten).toEqual([
      {
        file: 'apps/a/src/styles.scss',
        kind: 'sass-load-path',
        before: 'theme',
        after: '../../../libs/l/styles/theme',
      },
    ]);
  });

  it('keeps a bare path the workspace load paths still resolve to the same file', () => {
    const { tree, result } = run(
      (src) => {
        putJson(src, 'angular.json', angular(['lib/styles']));
        put(src, 'lib/styles/_theme.scss', '');
        put(src, 'app/src/styles.scss', "@use 'theme';\n");
      },
      (t) =>
        t.write(
          'apps/a/project.json',
          JSON.stringify({
            targets: {
              build: { options: { stylePreprocessorOptions: { includePaths: ['libs/l/styles'] } } },
            },
          }),
        ),
    );
    expect(tree.read('apps/a/src/styles.scss', 'utf8')).toBe("@use 'theme';\n");
    expect(result.rewritten).toEqual([]);
  });

  it('lists a bare path whose load-path file was not imported, and a missing workspace load path', () => {
    const { result } = run(
      (src) => {
        putJson(src, 'angular.json', angular(['other/styles']));
        put(src, 'other/styles/_vars.scss', '');
        put(src, 'app/src/styles.scss', "@use 'vars';\n@use 'nowhere';\n");
      },
      (t) =>
        t.write(
          'apps/a/project.json',
          JSON.stringify({
            targets: {
              build: {
                configurations: {
                  production: { stylePreprocessorOptions: { includePaths: ['other/styles'] } },
                },
              },
            },
          }),
        ),
    );
    expect(result.unresolved).toEqual([
      {
        file: 'apps/a/project.json',
        spec: 'other/styles',
        why: 'Sass load path that does not exist in the workspace',
      },
      {
        file: 'apps/a/src/styles.scss',
        spec: 'vars',
        why: 'resolves through the source Sass load paths to a file that was not imported',
      },
    ]);
  });

  it('uses only the load paths of the project that owns the stylesheet (review #1)', () => {
    const { tree, result } = run(
      (src) => {
        putJson(src, 'angular.json', {
          version: 1,
          projects: {
            l: {
              root: 'lib',
              architect: {
                build: { options: { stylePreprocessorOptions: { includePaths: ['lib/styles'] } } },
              },
            },
            a: {
              root: 'app',
              architect: {
                build: { options: { stylePreprocessorOptions: { includePaths: ['app/styles'] } } },
              },
            },
          },
        });
        put(src, 'lib/styles/_theme.scss', '');
        put(src, 'app/styles/_theme.scss', '');
        put(src, 'app/src/styles.scss', "@use 'theme';\n");
      },
      (t) =>
        t.write(
          'apps/a/project.json',
          JSON.stringify({
            targets: {
              build: { options: { stylePreprocessorOptions: { includePaths: ['apps/a/styles'] } } },
            },
          }),
        ),
    );
    expect(tree.read('apps/a/src/styles.scss', 'utf8')).toBe("@use 'theme';\n");
    expect(result.rewritten).toEqual([]);
  });

  it('leaves `with (...)` values alone and node_modules load paths to the workspace (review #2, #3)', () => {
    const { tree, result } = run((src) => {
      putJson(src, 'angular.json', angular(['lib/themes', 'node_modules']));
      put(src, 'lib/themes/_theme.scss', '');
      put(src, 'lib/themes/_dark.scss', '');
      put(src, 'node_modules/bootstrap/scss/_functions.scss', '');
      put(
        src,
        'app/src/styles.scss',
        "@use 'theme' with ($mode: 'dark');\n@use 'bootstrap/scss/functions';\n",
      );
    });
    expect(tree.read('apps/a/src/styles.scss', 'utf8')).toBe(
      "@use '../../../libs/l/themes/theme' with ($mode: 'dark');\n@use 'bootstrap/scss/functions';\n",
    );
    expect(result.unresolved).toEqual([]);
  });

  it('a bare path next to the stylesheet in the same copied folder is unchanged', () => {
    const { tree, result } = run((src) => {
      put(src, 'app/src/_local.scss', '');
      put(src, 'app/src/styles.scss', "@use 'local';\n");
    });
    expect(tree.read('apps/a/src/styles.scss', 'utf8')).toBe("@use 'local';\n");
    expect(result.rewritten).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});
