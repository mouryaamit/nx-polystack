import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { buildEntry } from '../../src/lib/utils/angular-project';
import addCspNonceImport from '../../src/migrations/add-csp-nonce-import/add-csp-nonce-import';

describe('add-csp-nonce-import migration', () => {
  it('finds main.ts of an application-builder app (options.browser, Angular 17+)', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'apps/web/project.json',
      JSON.stringify({
        name: 'web',
        targets: {
          build: {
            executor: '@angular/build:application',
            options: { browser: 'apps/web/src/main.ts' },
          },
          release: {
            executor: '@mouryaamit/nx-polystack:build',
            options: { type: 'angular', buildTarget: 'web:build' },
          },
        },
      }),
    );
    tree.write('apps/web/src/main.ts', "import { x } from 'y';\n");
    addCspNonceImport(tree);
    expect(tree.read('apps/web/src/main.ts', 'utf8')).toContain('runtime/csp-nonce');
  });

  it('buildEntry: main, else browser; ./ dropped; nothing for empty or missing', () => {
    expect(buildEntry({ main: 'apps/a/src/main.ts', browser: 'x' })).toBe('apps/a/src/main.ts');
    expect(buildEntry({ browser: './apps/a/src/main.ts' })).toBe('apps/a/src/main.ts');
    expect(buildEntry({ browser: '' })).toBeUndefined();
    expect(buildEntry(undefined)).toBeUndefined();
  });

  it('adds the import to apps with the polystack release target only', () => {
    const tree = createTreeWithEmptyWorkspace();
    const app = (name: string, type?: string) => {
      tree.write(
        `apps/${name}/project.json`,
        JSON.stringify({
          name,
          targets: {
            build: {
              executor: '@angular-devkit/build-angular:browser',
              options: { main: `apps/${name}/src/main.ts` },
            },
            ...(type
              ? {
                  release: {
                    executor: '@mouryaamit/nx-polystack:build',
                    options: { type, buildTarget: `${name}:build` },
                  },
                }
              : {}),
          },
        }),
      );
      tree.write(`apps/${name}/src/main.ts`, "import { x } from 'y';\n");
    };
    app('web', 'angular');
    app('mobile', 'ionic');
    app('plain');
    addCspNonceImport(tree);
    expect(tree.read('apps/web/src/main.ts', 'utf8')).toContain(
      '@mouryaamit/nx-polystack/runtime/csp-nonce',
    );
    expect(tree.read('apps/mobile/src/main.ts', 'utf8')).toContain('runtime/csp-nonce');
    expect(tree.read('apps/plain/src/main.ts', 'utf8')).not.toContain('runtime/csp-nonce');
    const again = tree.read('apps/web/src/main.ts', 'utf8');
    addCspNonceImport(tree);
    expect(tree.read('apps/web/src/main.ts', 'utf8')).toBe(again);
  });
});
