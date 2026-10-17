import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import releaseHardening from '../../src/migrations/release-hardening/release-hardening';

const HARDENED = {
  leakCheck: 'fail',
  sourceMaps: 'fail',
  stripComments: true,
  dropConsole: ['log', 'debug', 'warn'],
};

describe('release-hardening migration', () => {
  let tree: Tree;
  let info: jest.SpyInstance;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write('package.json', JSON.stringify({ devDependencies: { nx: '17.0.6' } }));
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const project = (root: string, targets: Record<string, unknown>) =>
    tree.write(`${root}/project.json`, JSON.stringify({ name: root.split('/').pop(), targets }));
  const release = (configurations: Record<string, unknown>, options: object = {}) => ({
    executor: '@mouryaamit/nx-polystack:build',
    options: { type: 'angular', outputPath: 'dist/x', envProject: 'x', ...options },
    configurations,
  });
  const targetsOf = (root: string) => readJson(tree, `${root}/project.json`).targets;

  it('turns the options on for UAT and PROD configurations only', async () => {
    project('apps/web', {
      release: release({
        dev: { env: 'DEV', buildConfiguration: 'development' },
        uat: { env: 'uat', buildConfiguration: 'uat' },
        prod: { env: 'PROD', buildConfiguration: 'production' },
        qa: { env: 'QA', buildConfiguration: 'qa' },
      }),
    });
    const cb = await releaseHardening(tree);
    const { configurations } = targetsOf('apps/web').release;
    expect(configurations.dev).toEqual({ env: 'DEV', buildConfiguration: 'development' });
    expect(configurations.uat).toEqual({ env: 'uat', buildConfiguration: 'uat', ...HARDENED });
    expect(configurations.prod).toEqual({
      env: 'PROD',
      buildConfiguration: 'production',
      ...HARDENED,
    });
    expect(configurations.qa).toEqual({ env: 'QA', buildConfiguration: 'qa' });
    expect(typeof cb).toBe('function');
    const logged = info.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('updated release hardening for web');
    expect(logged).toContain(
      'leakCheck/sourceMaps fail the build on a hit; set them to "warn" to report only',
    );
  });

  it('keeps values that are already set and finds projects in any folder', async () => {
    project('legacy/portal', {
      'release-web': release({
        prod: { env: 'PROD', leakCheck: 'warn', dropConsole: ['log'], stripComments: false },
      }),
    });
    await releaseHardening(tree);
    expect(targetsOf('legacy/portal')['release-web'].configurations.prod).toEqual({
      env: 'PROD',
      leakCheck: 'warn',
      sourceMaps: 'fail',
      stripComments: false,
      dropConsole: ['log'],
    });
  });

  it('counts a key set in the target options as set', async () => {
    project('apps/web', {
      release: release({ prod: { env: 'PROD' } }, { sourceMaps: 'warn', stripComments: false }),
    });
    await releaseHardening(tree);
    expect(targetsOf('apps/web').release.configurations.prod).toEqual({
      env: 'PROD',
      leakCheck: 'fail',
      dropConsole: ['log', 'debug', 'warn'],
    });
  });

  it('keeps what harden: true meant for other envs, and names those configurations', async () => {
    project('apps/web', {
      release: release(
        {
          dev: { env: 'DEV' },
          qa: { env: 'QA' },
          stage: { env: 'STAGE', harden: false },
          demo: { env: 'DEMO', dropConsole: ['log'] },
        },
        { harden: true },
      ),
    });
    project('apps/admin', {
      release: release({ qa: { env: 'QA', harden: true }, perf: { env: 'PERF' } }),
    });
    await releaseHardening(tree);
    const web = targetsOf('apps/web').release.configurations;
    expect(web.dev).toEqual({ env: 'DEV' });
    expect(web.qa).toEqual({
      env: 'QA',
      stripComments: true,
      dropConsole: ['log', 'debug', 'warn'],
    });
    expect(web.stage).toEqual({ env: 'STAGE' });
    expect(web.demo).toEqual({ env: 'DEMO', stripComments: true, dropConsole: ['log'] });
    const admin = targetsOf('apps/admin').release.configurations;
    expect(admin.qa).toEqual({
      env: 'QA',
      stripComments: true,
      dropConsole: ['log', 'debug', 'warn'],
    });
    expect(admin.perf).toEqual({ env: 'PERF' });
    const logged = info.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain(
      'harden replaced by stripComments and dropConsole in web:qa, web:demo, admin:qa',
    );
  });

  it('removes harden from options and every configuration', async () => {
    project('apps/web', {
      release: release(
        { dev: { env: 'DEV', harden: true }, prod: { env: 'PROD', harden: false } },
        { harden: true },
      ),
    });
    await releaseHardening(tree);
    const r = targetsOf('apps/web').release;
    expect(r.options).not.toHaveProperty('harden');
    expect(r.configurations.dev).toEqual({ env: 'DEV' });
    expect(r.configurations.prod).toEqual({ env: 'PROD', ...HARDENED });
  });

  it('adds terser once and keeps a declared version', async () => {
    project('apps/web', { release: release({ uat: { env: 'UAT' } }) });
    project('apps/admin', { release: release({ prod: { env: 'PROD' } }) });
    await releaseHardening(tree);
    expect(readJson(tree, 'package.json').devDependencies.terser).toBe('^5.16.0');

    tree.write('package.json', JSON.stringify({ devDependencies: { terser: '5.19.2' } }));
    project('apps/shop', { release: release({ prod: { env: 'PROD' } }) });
    await releaseHardening(tree);
    expect(readJson(tree, 'package.json').devDependencies.terser).toBe('5.19.2');
  });

  it('is a no-op without polystack release targets, and the second time', async () => {
    project('apps/api', {
      build: { executor: '@nx/node:build', configurations: { prod: { env: 'PROD' } } },
    });
    project('libs/ui', {});
    const before = tree.read('package.json', 'utf8');
    expect(await releaseHardening(tree)).toBeUndefined();
    expect(tree.read('package.json', 'utf8')).toBe(before);
    expect(info).not.toHaveBeenCalled();

    project('apps/web', { release: release({ prod: { env: 'PROD' } }) });
    await releaseHardening(tree);
    const once = tree.read('apps/web/project.json', 'utf8');
    info.mockClear();
    expect(await releaseHardening(tree)).toBeUndefined();
    expect(tree.read('apps/web/project.json', 'utf8')).toBe(once);
    expect(info).not.toHaveBeenCalled();
  });
});
