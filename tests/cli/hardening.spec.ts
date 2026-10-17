import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { COMMANDS } from '../../src/cli/commands';
import { runHardening } from '../../src/cli/commands/hardening';
import { helpText } from '../../src/cli/help';
import { MIN_LOCAL_VERSION, WORKSPACE_COMMANDS } from '../../src/cli/launcher';

import { makeCtx, tmpDir, writeJson } from './helpers';

const EXECUTOR = '@mouryaamit/nx-polystack:build';

function workspace(release?: Record<string, unknown>): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), { name: '@acme/source', devDependencies: {} });
  writeJson(path.join(ws, 'apps', 'web', 'project.json'), {
    name: 'web',
    targets: {
      build: { executor: '@angular-devkit/build-angular:browser' },
      ...(release === undefined
        ? {}
        : {
            release: {
              executor: EXECUTOR,
              options: { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web' },
              configurations: {
                dev: { env: 'DEV' },
                uat: { env: 'UAT', leakCheck: 'fail' },
                prod: { env: 'PROD' },
                ...release,
              },
            },
          }),
    },
  });
  return ws;
}
const release = (ws: string) =>
  JSON.parse(fs.readFileSync(path.join(ws, 'apps', 'web', 'project.json'), 'utf8')).targets.release;
const devDeps = (ws: string) =>
  JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8')).devDependencies;
const out = () => (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
const run = (ws: string, flags: Record<string, string | boolean>) =>
  runHardening(makeCtx({ cwd: ws, flags }));

describe('pstack hardening', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is a workspace command delegated to plugins from 0.30.0', () => {
    expect(COMMANDS['hardening']).toBeDefined();
    expect(WORKSPACE_COMMANDS.has('hardening')).toBe(true);
    expect(MIN_LOCAL_VERSION['hardening']).toBe('0.30.0');
    expect(helpText('0.30.0')).toContain('--obfuscate=<level>');
  });

  it('shows the effective options per configuration without changing anything', async () => {
    const ws = workspace({});
    const before = fs.readFileSync(path.join(ws, 'apps', 'web', 'project.json'), 'utf8');
    expect(await run(ws, { app: 'web' })).toBe(0);
    expect(out()).toContain('Release hardening of web (release):');
    expect(out()).toMatch(/uat\s+leakCheck fail · sourceMaps off · stripComments false/);
    expect(out()).toMatch(/dev\s+DEV: no hardening steps run/);
    expect(out()).toContain('obfuscate off · sri false');
    expect(fs.readFileSync(path.join(ws, 'apps', 'web', 'project.json'), 'utf8')).toBe(before);
  });

  it('sets options on every non-DEV configuration by default', async () => {
    const ws = workspace({});
    await run(ws, {
      app: 'web',
      sri: true,
      sourceMaps: 'warn',
      stripComments: true,
      dropConsole: 'log,warn',
    });
    const t = release(ws);
    for (const c of ['uat', 'prod']) {
      expect(t.configurations[c]).toMatchObject({
        sri: true,
        sourceMaps: 'warn',
        stripComments: true,
        dropConsole: ['log', 'warn'],
      });
    }
    expect(t.configurations.dev).toEqual({ env: 'DEV' });
    expect(devDeps(ws).terser).toBe('^5.16.0');
    expect(devDeps(ws)['javascript-obfuscator']).toBeUndefined();
  });

  it('sets one configuration and adds javascript-obfuscator when obfuscation is turned on', async () => {
    const ws = workspace({});
    await run(ws, { app: 'web', configuration: 'uat', obfuscate: 'light' });
    const t = release(ws);
    expect(t.configurations.uat.obfuscate).toBe('light');
    expect(t.configurations.prod.obfuscate).toBeUndefined();
    expect(devDeps(ws)['javascript-obfuscator']).toBe('^4.2.2');
    expect(out()).toContain('start-up time');
    expect(out()).toContain('run npm install');
  });

  it('sets and clears obfuscateOptions and shows them', async () => {
    const ws = workspace({});
    await run(ws, {
      app: 'web',
      configuration: 'prod',
      obfuscate: 'medium',
      obfuscateOptions: '{"stringArrayThreshold":0.3}',
    });
    expect(release(ws).configurations.prod).toMatchObject({
      obfuscate: 'medium',
      obfuscateOptions: { stringArrayThreshold: 0.3 },
    });
    expect(out()).toContain('obfuscate medium {"stringArrayThreshold":0.3} · sri');
    await run(ws, { app: 'web', configuration: 'prod', obfuscateOptions: 'none' });
    expect(release(ws).configurations.prod.obfuscateOptions).toBeUndefined();
  });

  it('turns options off: --sri=false, --drop-console=none, --obfuscate=off', async () => {
    const ws = workspace({
      uat: { env: 'UAT', sri: true, dropConsole: ['log'], obfuscate: 'light' },
    });
    await run(ws, {
      app: 'web',
      configuration: 'uat',
      sri: 'false',
      dropConsole: 'none',
      obfuscate: 'off',
    });
    expect(release(ws).configurations.uat).toMatchObject({
      sri: false,
      dropConsole: [],
      obfuscate: 'off',
    });
  });

  it('rejects unknown values, configurations and apps without a release target', async () => {
    const ws = workspace({});
    await expect(run(ws, { app: 'web', obfuscate: 'heavy' })).rejects.toThrow(
      '--obfuscate must be off, light, medium, strong.',
    );
    await expect(run(ws, { app: 'web', obfuscateOptions: '{bad' })).rejects.toThrow(
      /--obfuscate-options must be JSON/,
    );
    await expect(
      run(ws, { app: 'web', obfuscateOptions: '{"debugProtection":true}' }),
    ).rejects.toThrow(/obfuscateOptions.debugProtection cannot be set/);
    await expect(run(ws, { app: 'web', leakCheck: 'loud' })).rejects.toThrow(
      '--leak-check must be fail, warn or off.',
    );
    await expect(run(ws, { app: 'web', dropConsole: 'log,print' })).rejects.toThrow(
      /--drop-console: unknown console method "print"/,
    );
    await expect(run(ws, { app: 'web', configuration: 'qa', sri: true })).rejects.toThrow(
      'The release target of "web" has no configuration "qa".',
    );
    await expect(run(ws, { app: 'mobile' })).rejects.toThrow('No project named "mobile".');
    await expect(run(workspace(), { app: 'web' })).rejects.toThrow(/pstack update/);
    await expect(run(ws, {})).rejects.toThrow('--app=<project> is required.');
    await expect(run(ws, { app: 'web', obfuscate: true })).rejects.toThrow(
      '--obfuscate needs a value.',
    );
  });
});
