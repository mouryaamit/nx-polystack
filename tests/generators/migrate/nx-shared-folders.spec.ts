import { SharedFolderFinder } from '../../../src/generators/migrate/nx/shared-folders';

import { put, tmpSource } from './helpers';

describe('shared folder finder', () => {
  it('finds folders from options, tsconfig, scripts and imports', () => {
    const src = tmpSource();
    for (const f of [
      'apps/web/src/main.ts',
      'libs/ui/src/index.ts',
      'libs/assets/a.svg',
      'environments/web/environment.ts',
      'tools/scripts/build.js',
      'tools/types/g.d.ts',
      'config/x.json',
    ]) {
      put(src, f, '');
    }
    const finder = new SharedFolderFinder({
      sourceDir: src,
      projectRoots: ['apps/web', 'libs/ui'],
    });
    finder.addProjectConfig('web', {
      targets: {
        build: {
          options: {
            assets: [{ input: 'libs/assets', glob: '**/*' }, 'apps/web/src/favicon.ico'],
            styles: ['node_modules/x/x.css', 'libs/ui/src/x.css'],
          },
          configurations: {
            prod: {
              fileReplacements: [
                { replace: 'environments/environment.ts', with: 'environments/web/environment.ts' },
              ],
            },
          },
        },
      },
    });
    finder.addTsconfig({
      compilerOptions: { typeRoots: ['node_modules/@types', 'tools/types'] },
      include: ['apps/**/*.ts'],
    });
    finder.addScripts({ build: 'node tools/scripts/build.js --env=x', lint: 'eslint .' });
    finder.addCode(
      'apps/web/src/main.ts',
      "import '../../../tools/scripts/build';\nimport { c } from 'config/x';\nimport '@angular/core';",
      true,
    );
    expect(finder.folders().map((f) => [f.path, f.reasons])).toEqual([
      ['config', ['imported by apps/web/src/main.ts']],
      ['environments', ['replace of web', 'with of web']],
      ['libs/assets', ['assets of web']],
      ['tools', ['imported by apps/web/src/main.ts', 'npm script "build"', 'typeRoots']],
    ]);
  });
});
