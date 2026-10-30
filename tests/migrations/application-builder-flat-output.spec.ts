import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import applicationBuilderFlatOutput from '../../src/migrations/application-builder-flat-output/application-builder-flat-output';

const RELEASE = '@mouryaamit/nx-polystack:build';

describe('application-builder-flat-output migration (NX-113)', () => {
  let tree: Tree;
  let info: string[];
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    info = [];
    jest.spyOn(logger, 'info').mockImplementation((m) => void info.push(String(m)));
  });
  afterEach(() => jest.restoreAllMocks());

  const app = (name: string, build: unknown, releaseOut = `dist/${name}`) =>
    tree.write(
      `apps/${name}/project.json`,
      // Not pstack's layout: the release target on one line.
      `{\n  "name": "${name}",\n  "targets": {\n    "build": ${JSON.stringify(
        build,
      )},\n    "release": { "executor": "${RELEASE}", "options": { "outputPath": "${releaseOut}", "buildTarget": "${name}:build" } }\n  }\n}\n`,
    );

  it('sets browser "" on application-builder targets a release builds, keeps the layout', async () => {
    app('web', {
      executor: '@angular/build:application',
      options: { outputPath: { base: 'dist/web' } },
      configurations: { uat: { outputPath: 'dist/web' } },
    });
    app('site', {
      executor: '@angular-devkit/build-angular:application',
      options: { outputPath: 'dist/site' },
    });
    await applicationBuilderFlatOutput(tree);
    const web = readJson(tree, 'apps/web/project.json').targets.build;
    expect(web.options.outputPath).toEqual({ base: 'dist/web', browser: '' });
    expect(web.configurations.uat.outputPath).toEqual({ base: 'dist/web', browser: '' });
    expect(readJson(tree, 'apps/site/project.json').targets.build.options.outputPath).toEqual({
      base: 'dist/site',
      browser: '',
    });
    expect(tree.read('apps/web/project.json', 'utf8')).toContain(
      `"release": { "executor": "${RELEASE}", "options": { "outputPath": "dist/web", "buildTarget": "web:build" } }`,
    );
  });

  it('leaves browser-builder apps, flat apps, apps without release, and is idempotent', async () => {
    app('old', {
      executor: '@angular-devkit/build-angular:browser',
      options: { outputPath: 'dist/old' },
    });
    app('flat', {
      executor: '@angular/build:application',
      options: { outputPath: { base: 'dist/flat', browser: '' } },
    });
    tree.write(
      'apps/plain/project.json',
      JSON.stringify({
        name: 'plain',
        targets: {
          build: { executor: '@angular/build:application', options: { outputPath: 'dist/plain' } },
        },
      }),
    );
    const before = ['old', 'flat', 'plain'].map((a) => tree.read(`apps/${a}/project.json`, 'utf8'));
    await applicationBuilderFlatOutput(tree);
    await applicationBuilderFlatOutput(tree);
    expect(
      ['old', 'flat', 'plain'].map((a) => tree.read(`apps/${a}/project.json`, 'utf8')),
    ).toEqual(before);
  });

  it('lists SSR builds and release outputPaths that are not the build base', async () => {
    app('ssr', {
      executor: '@angular/build:application',
      options: { outputPath: { base: 'dist/ssr' }, ssr: { entry: 'server.ts' } },
    });
    app(
      'moved',
      {
        executor: '@angular/build:application',
        options: { outputPath: { base: 'dist/portal', browser: '' } },
      },
      'dist/moved',
    );
    await applicationBuilderFlatOutput(tree);
    expect(readJson(tree, 'apps/ssr/project.json').targets.build.options.outputPath).toEqual({
      base: 'dist/ssr',
    });
    expect(info.join('\n')).toContain('apps/ssr/project.json build: server rendering');
    expect(info.join('\n')).toContain(
      'apps/moved/project.json release: outputPath "dist/moved" is not the build base "dist/portal"',
    );
  });
});
