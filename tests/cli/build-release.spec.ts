import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { COMMANDS } from '../../src/cli/commands';
import { runBuild } from '../../src/cli/commands/build';
import { runRelease } from '../../src/cli/commands/release';
import { helpText } from '../../src/cli/help';
import {
  delegationArgs,
  MIN_LOCAL_FLAG_VERSION,
  MIN_LOCAL_VERSION,
  WORKSPACE_COMMANDS,
} from '../../src/cli/launcher';
import { Spawner } from '../../src/lib/release/run';

import { makeCtx, tmpDir, writeJson } from './helpers';

const POLY = '@mouryaamit/nx-polystack:build';
const FLUTTER = '@mouryaamit/nx-polystack:flutter-build';

function workspace(): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), { name: '@acme/source' });
  writeJson(path.join(ws, 'apps', 'portal', 'project.json'), {
    name: 'portal',
    targets: {
      release: {
        executor: POLY,
        options: { outputPath: 'dist/apps/portal' },
        configurations: { dev: { env: 'DEV' }, uat: { env: 'UAT' }, prod: { env: 'PROD' } },
      },
    },
  });
  writeJson(path.join(ws, 'apps', 'legacy', 'admin', 'project.json'), {
    name: 'admin',
    targets: {
      release: { executor: POLY, configurations: { development: { env: 'DEV' } } },
    },
  });
  writeJson(path.join(ws, 'apps', 'mobile', 'project.json'), {
    targets: {
      'build-web': {
        executor: FLUTTER,
        options: { target: 'web', dist: 'dist/apps/mobile/web' },
        configurations: { dev: { env: 'dev' }, uat: { env: 'uat' }, prod: { env: 'prod' } },
      },
    },
  });
  writeJson(path.join(ws, 'libs', 'shared', 'project.json'), { name: 'shared', targets: {} });
  return ws;
}

const out = () => (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
const project = (ws: string, rel: string) =>
  JSON.parse(fs.readFileSync(path.join(ws, rel, 'project.json'), 'utf8'));

describe('pstack build', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is a workspace command delegated to plugins from 0.32.0', () => {
    for (const c of ['build', 'release']) {
      expect(COMMANDS[c]).toBeDefined();
      expect(WORKSPACE_COMMANDS.has(c)).toBe(true);
      expect(MIN_LOCAL_VERSION[c]).toBe('0.32.0');
    }
    expect(helpText('0.32.0')).toContain('pstack build --env=uat --all');
    expect(helpText('0.32.0')).toContain('--base-href=<path>');
    expect(MIN_LOCAL_FLAG_VERSION['app']['baseHref']).toBe('0.32.0');
    expect(
      delegationArgs(
        'build',
        ['build', '--env=uat', '--all', '--report=out/r.json'],
        '/ws/apps',
        '/ws',
      ),
    ).toEqual([
      'build',
      '--env=uat',
      '--all',
      `--report=${path.resolve('/ws/apps', 'out/r.json')}`,
    ]);
  });

  it('dry run lists the plan and the apps without the configuration', async () => {
    const ws = workspace();
    expect(
      await runBuild(makeCtx({ cwd: ws, flags: { env: 'uat', all: true }, dryRun: true })),
    ).toBe(0);
    expect(out()).toContain('▶ npx nx run mobile:build-web:uat');
    expect(out()).toContain('▶ npx nx run portal:release:uat');
    expect(out()).toContain('– admin: no uat configuration (release)');
  });

  it('runs the builds, prints the summary, writes the report and returns 1 on a failure', async () => {
    const ws = workspace();
    const calls: string[] = [];
    const spawner: Spawner = async (cmd, args) => {
      calls.push(args.join(' '));
      if (args[2].startsWith('portal')) {
        fs.mkdirSync(path.join(ws, 'dist/apps/portal'), { recursive: true });
        fs.writeFileSync(path.join(ws, 'dist/apps/portal/main.js'), 'x'.repeat(2048));
        return 0;
      }
      return 3;
    };
    let t = 0;
    const code = await runBuild(
      makeCtx({ cwd: ws, flags: { env: 'uat', all: true, continue: true, report: 'out/r.json' } }),
      { spawner, now: () => (t += 1000) },
    );
    expect(code).toBe(1);
    expect(calls).toEqual(['nx run mobile:build-web:uat', 'nx run portal:release:uat']);
    expect(out()).toContain(
      'pstack build --env=uat — 2 build(s), 1 passed, 1 failed, 1 without a uat configuration',
    );
    expect(out()).toMatch(/✔ portal\s+release:uat\s+0m 01s\s+dist\/apps\/portal\s+2\.0 kB/);
    const report = JSON.parse(fs.readFileSync(path.join(ws, 'out/r.json'), 'utf8'));
    expect(report.env).toBe('uat');
    expect(report.builds).toEqual([
      expect.objectContaining({ project: 'mobile', status: 'failed', exitCode: 3 }),
      expect.objectContaining({ project: 'portal', status: 'passed', bytes: 2048 }),
    ]);
    expect(report.missing).toEqual([{ project: 'admin', target: 'release' }]);
  });

  it('validates its flags', async () => {
    const ws = workspace();
    const run = (flags: Record<string, string | boolean>) => runBuild(makeCtx({ cwd: ws, flags }));
    await expect(run({ all: true })).rejects.toThrow('--env is required');
    await expect(run({ env: 'uat' })).rejects.toThrow('Pass either --all or --projects');
    await expect(run({ env: 'uat', all: true, projects: 'portal' })).rejects.toThrow(
      'Pass either --all or --projects',
    );
    await expect(run({ env: 'uat', all: true, parallel: '9' })).rejects.toThrow(
      '--parallel must be a whole number from 1 to 8.',
    );
    await expect(run({ env: 'uat', all: true, flutterPlatforms: 'web,linux' })).rejects.toThrow(
      '"linux" is not one of web, android, ios',
    );
    await expect(run({ env: 'uat', projects: 'portal,ghost' })).rejects.toThrow(
      'unknown project(s): ghost',
    );
    await expect(run({ env: true, all: true })).rejects.toThrow('--env needs a value.');
    await expect(run({ env: 'uat', projects: ',' })).rejects.toThrow(
      '--projects needs at least one project name.',
    );
    await expect(run({ env: 'uat', all: true, exclude: '' })).rejects.toThrow(
      '--exclude needs at least one project name.',
    );
    await expect(run({ env: 'uat', projects: 'shared' })).rejects.toThrow(
      'None of the selected projects has a release target',
    );
  });
});

describe('workspace discovery', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('reads project.json with comments and fails on duplicate names', async () => {
    const ws = workspace();
    fs.writeFileSync(
      path.join(ws, 'apps', 'portal', 'project.json'),
      '{ // portal\n "name": "portal", "targets": { "release": { "executor": "' +
        POLY +
        '", "configurations": { "uat": {}, }, }, }, }',
    );
    await runBuild(makeCtx({ cwd: ws, flags: { env: 'uat', all: true }, dryRun: true }));
    expect(out()).toContain('▶ npx nx run portal:release:uat');

    writeJson(path.join(ws, 'other', 'portal', 'project.json'), { targets: {} });
    await expect(
      runBuild(makeCtx({ cwd: ws, flags: { env: 'uat', all: true }, dryRun: true })),
    ).rejects.toThrow('two projects are named "portal" (apps/portal, other/portal)');
  });

  it('pstack release finds apps outside apps/ and libs/', async () => {
    const ws = workspace();
    writeJson(path.join(ws, 'products', 'shop', 'project.json'), {
      name: 'shop',
      targets: { release: { executor: POLY, configurations: { uat: { env: 'UAT' } } } },
    });
    await runRelease(makeCtx({ cwd: ws, flags: { app: 'shop', baseHref: '/shop/' } }));
    expect(project(ws, 'products/shop').targets.release.configurations.uat.baseHref).toBe('/shop/');
  });
});

describe('pstack release', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows, sets on every non-DEV configuration, sets one and removes the base href', async () => {
    const ws = workspace();
    await runRelease(makeCtx({ cwd: ws, flags: { app: 'portal' } }));
    expect(out()).toMatch(/uat\s+— \(none\)/);

    await runRelease(makeCtx({ cwd: ws, flags: { app: 'portal', baseHref: '/portal/' } }));
    let conf = project(ws, 'apps/portal').targets.release.configurations;
    expect(conf.dev.baseHref).toBeUndefined();
    expect(conf.uat.baseHref).toBe('/portal/');
    expect(conf.prod.baseHref).toBe('/portal/');

    await runRelease(
      makeCtx({ cwd: ws, flags: { app: 'portal', configuration: 'uat', baseHref: 'none' } }),
    );
    conf = project(ws, 'apps/portal').targets.release.configurations;
    expect(conf.uat.baseHref).toBeUndefined();
    expect(conf.prod.baseHref).toBe('/portal/');
    expect(out()).toContain('Note: Removed from uat.');

    await runRelease(
      makeCtx({ cwd: ws, flags: { app: 'portal', configuration: 'prod', baseHref: '/portal/' } }),
    );
    expect(out()).toContain('Note: Already /portal/ on prod.');
  });

  it('uses build-web for Flutter apps (named after their folder)', async () => {
    const ws = workspace();
    await runRelease(makeCtx({ cwd: ws, flags: { app: 'mobile', baseHref: '/m/' } }));
    const conf = project(ws, 'apps/mobile').targets['build-web'].configurations;
    expect([conf.dev.baseHref, conf.uat.baseHref, conf.prod.baseHref]).toEqual([
      undefined,
      '/m/',
      '/m/',
    ]);
    expect(out()).toContain('Base href of mobile (build-web):');
  });

  it('rejects bad input', async () => {
    const ws = workspace();
    const run = (flags: Record<string, string | boolean>) =>
      runRelease(makeCtx({ cwd: ws, flags }));
    await expect(run({})).rejects.toThrow('--app=<project> is required.');
    await expect(run({ app: 'portal', baseHref: 'portal' })).rejects.toThrow(
      'must start and end with "/"',
    );
    await expect(run({ app: 'portal', configuration: 'qa', baseHref: '/x/' })).rejects.toThrow(
      'has no configuration "qa"',
    );
    await expect(run({ app: 'shared' })).rejects.toThrow(/has no release target/);
    await expect(run({ app: 'admin', baseHref: '/a/' })).rejects.toThrow(
      '"admin" has no non-DEV configuration.',
    );
    await expect(run({ app: 'ghost' })).rejects.toThrow('No project named "ghost".');
  });
});
