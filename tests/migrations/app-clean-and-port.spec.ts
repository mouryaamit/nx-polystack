import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import appCleanAndPort from '../../src/migrations/app-clean-and-port/app-clean-and-port';

const DEV_SERVER = '@angular-devkit/build-angular:dev-server';

describe('app-clean-and-port migration', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const app = (root: string, targets: Record<string, unknown>, projectType = 'application') =>
    tree.write(
      `${root}/project.json`,
      JSON.stringify({ name: root.split('/').pop(), projectType, targets }),
    );
  const pj = (root: string) => readJson(tree, `${root}/project.json`);

  it('adds clean targets from the build outputPath, Flutter with flutter clean', async () => {
    app('apps/portal', {
      build: {
        executor: '@angular-devkit/build-angular:browser',
        options: { outputPath: 'dist/web/portal/' },
      },
      serve: { executor: DEV_SERVER, options: { port: 4200 } },
    });
    app('apps/mobile', {
      serve: {
        executor: '@mouryaamit/nx-polystack:flutter-build',
        options: { target: 'web', serve: true, port: 4300 },
      },
    });
    app('libs/ui', { build: { executor: '@nx/angular:package' } }, 'library');

    await appCleanAndPort(tree);

    expect(pj('apps/portal').targets.clean).toEqual({
      executor: '@mouryaamit/nx-polystack:clean',
      options: { paths: ['dist/web/portal', 'coverage/apps/portal'] },
    });
    expect(pj('apps/mobile').targets.clean.options).toEqual({
      paths: ['dist/apps/mobile', 'coverage/apps/mobile'],
      flutter: true,
    });
    expect(pj('libs/ui').targets.clean).toBeUndefined();
  });

  it('keeps an existing clean target', async () => {
    const clean = { executor: 'nx:run-commands', options: { command: 'rm -rf dist' } };
    app('apps/portal', { serve: { executor: DEV_SERVER, options: { port: 4200 } }, clean });
    await appCleanAndPort(tree);
    expect(pj('apps/portal').targets.clean).toEqual(clean);
  });

  it('spreads apps that all fell back to 4200; the first by name keeps it', async () => {
    app('apps/zeta', { serve: { executor: DEV_SERVER } });
    app('apps/alpha', { serve: { executor: '@nx/angular:dev-server', options: {} } });
    app('apps/beta', { serve: { executor: DEV_SERVER, options: { port: 4201 } } });
    app('apps/gamma', { serve: { executor: DEV_SERVER } });

    await appCleanAndPort(tree);

    expect(pj('apps/alpha').targets.serve.options).toEqual({});
    expect(pj('apps/beta').targets.serve.options.port).toBe(4201);
    expect(pj('apps/gamma').targets.serve.options.port).toBe(4202);
    expect(pj('apps/zeta').targets.serve.options.port).toBe(4203);
  });

  it('moves every implicit app when 4200 is set explicitly by another', async () => {
    app('apps/alpha', { serve: { executor: DEV_SERVER } });
    app('apps/beta', { serve: { executor: DEV_SERVER, options: { port: 4200 } } });
    await appCleanAndPort(tree);
    expect(pj('apps/alpha').targets.serve.options.port).toBe(4201);
  });

  it('changes nothing on a second run', async () => {
    app('apps/alpha', { serve: { executor: DEV_SERVER } });
    app('apps/beta', { serve: { executor: DEV_SERVER } });
    await appCleanAndPort(tree);
    const first = [pj('apps/alpha'), pj('apps/beta')];
    await appCleanAndPort(tree);
    expect([pj('apps/alpha'), pj('apps/beta')]).toEqual(first);
  });

  it('builds valid clean paths for a root project and skips refused output paths', async () => {
    tree.write(
      'project.json',
      JSON.stringify({
        name: 'site',
        projectType: 'application',
        targets: {
          build: {
            executor: '@angular-devkit/build-angular:browser',
            options: { outputPath: 'www' },
          },
          serve: { executor: DEV_SERVER, options: { port: 4200 } },
        },
      }),
    );
    app('apps/mobile', {
      build: {
        executor: '@angular-devkit/build-angular:browser',
        options: { outputPath: 'apps/mobile/src/out' },
      },
      serve: { executor: DEV_SERVER, options: { port: 4300 } },
    });
    await appCleanAndPort(tree);
    expect(readJson(tree, 'project.json').targets.clean.options.paths).toEqual([
      'www',
      'coverage/site',
    ]);
    expect(pj('apps/mobile').targets.clean.options.paths).toEqual([
      'dist/apps/mobile',
      'coverage/apps/mobile',
    ]);
    const said = (logger.info as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('left out of clean');
    expect(said).toContain('mobile (apps/mobile/src/out)');
  });

  it('counts a numeric string port as set', async () => {
    app('apps/alpha', { serve: { executor: DEV_SERVER } });
    app('apps/beta', { serve: { executor: DEV_SERVER, options: { port: '4300' } } });
    app('apps/gamma', { serve: { executor: DEV_SERVER } });
    await appCleanAndPort(tree);
    expect(pj('apps/alpha').targets.serve.options).toBeUndefined();
    expect(pj('apps/beta').targets.serve.options.port).toBe('4300');
    expect(pj('apps/gamma').targets.serve.options.port).toBe(4201);
  });

  it('leaves non-Angular dev servers alone', async () => {
    app('apps/react', { serve: { executor: '@nx/vite:dev-server' } });
    await appCleanAndPort(tree);
    expect(pj('apps/react').targets.clean).toBeUndefined();
  });

  it('is listed for 0.35.0', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const manifest = require('../../migrations.json');
    expect(manifest.generators['app-clean-and-port'].version).toBe('0.35.0');
  });
});
