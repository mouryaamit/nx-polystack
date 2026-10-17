import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { runApp } from '../../src/cli/commands/app';
import { helpText } from '../../src/cli/help';
import { assertLocalSupports } from '../../src/cli/launcher';
import { CliError } from '../../src/cli/types';

import { makeCtx, tmpDir, writeJson } from './helpers';

/** A minimal on-disk Nx workspace. */
function workspace(): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), { name: '@acme/source', scripts: {} });
  writeJson(path.join(ws, 'tsconfig.base.json'), { compilerOptions: { paths: {} } });
  return ws;
}

describe('pstack app --dir', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('puts the app in apps/<dir>/<name>', async () => {
    const ws = workspace();
    await runApp(makeCtx({ cwd: ws, flags: { type: 'flutter', name: 'notes', dir: 'legacy' } }));
    expect(fs.existsSync(path.join(ws, 'apps/legacy/notes/project.json'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'apps/notes'))).toBe(false);
  });

  it('checks --dir before looking for a workspace', async () => {
    const outside = tmpDir();
    const bad = runApp(makeCtx({ cwd: outside, flags: { type: 'flutter', name: 'n', dir: 'A' } }));
    await expect(bad).rejects.toBeInstanceOf(CliError);
    await expect(bad).rejects.toThrow(/^--dir="A" must be kebab-case folder names/);
    await expect(
      runApp(makeCtx({ cwd: outside, flags: { type: 'flutter', name: 'n', dir: true } })),
    ).rejects.toThrow('--dir needs a value');
    await expect(
      runApp(makeCtx({ cwd: outside, flags: { type: 'flutter', name: 'n', dir: '' } })),
    ).rejects.toThrow('--dir="" must be kebab-case folder names');
  });

  it('needs plugin 0.17.0 locally and is in the help', () => {
    expect(() => assertLocalSupports('app', '0.16.0', { dir: 'legacy' })).toThrow(
      'pstack app --dir needs nx-polystack >= 0.17.0',
    );
    expect(() => assertLocalSupports('app', '0.16.0', {})).not.toThrow();
    expect(helpText('0.17.0')).toContain('pstack app --type=angular --name=portal --dir=legacy');
  });
});

describe('pstack app --port / --env-layout and pstack shared (NX-43)', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const readPj = (ws: string, app: string) =>
    JSON.parse(fs.readFileSync(path.join(ws, 'apps', app, 'project.json'), 'utf8'));

  it('passes --port and --env-layout to the generator', async () => {
    const ws = workspace();
    await runApp(makeCtx({ cwd: ws, flags: { type: 'flutter', name: 'mobile', port: '4310' } }));
    expect(readPj(ws, 'mobile').targets.serve.options.port).toBe(4310);

    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runApp(
      makeCtx({
        cwd: ws,
        dryRun: true,
        flags: { type: 'angular', name: 'portal', envLayout: 'per-env' },
      }),
    );
    const said = [
      ...(logger.info as jest.Mock).mock.calls,
      ...(console.log as jest.Mock).mock.calls,
      ...stdout.mock.calls,
    ]
      .map((c) => String(c[0]))
      .join('\n');
    stdout.mockRestore();
    expect(said).toContain('environments/portal/environment.dev.ts');
    expect(said).toContain('environments/environment.ts');
  });

  it('checks the flag values', async () => {
    const ws = workspace();
    const run = (flags: Record<string, string | boolean>) =>
      runApp(makeCtx({ cwd: ws, flags: { type: 'angular', name: 'portal', ...flags } }));
    await expect(run({ port: 'abc' })).rejects.toThrow(
      '--port must be a whole number from 1024 to 65535 (got abc).',
    );
    await expect(run({ port: true })).rejects.toThrow('--port needs a value');
    await expect(run({ envLayout: 'flat' })).rejects.toThrow(
      '--env-layout must be default or per-env',
    );
    await expect(
      runApp(makeCtx({ cwd: ws, flags: { type: 'flutter', name: 'm', envLayout: 'per-env' } })),
    ).rejects.toThrow('--env-layout is for Angular and Ionic apps');
  });

  it('needs plugin 0.35.0 locally for the new flags and pstack shared', () => {
    expect(() => assertLocalSupports('app', '0.34.0', { port: '4300' })).toThrow(
      'pstack app --port needs nx-polystack >= 0.35.0',
    );
    expect(() => assertLocalSupports('app', '0.34.0', { envLayout: 'per-env' })).toThrow(
      'pstack app --env-layout needs nx-polystack >= 0.35.0',
    );
    expect(() => assertLocalSupports('shared', '0.34.0')).toThrow('0.35.0');
    expect(helpText('0.35.0')).toContain('pstack shared --all');
    expect(helpText('0.35.0')).toContain('--env-layout=<layout>');
  });

  it('pstack shared wires apps and checks its flags', async () => {
    const { runShared } = await import('../../src/cli/commands/shared');
    const ws = workspace();
    writeJson(path.join(ws, 'apps/legacy/project.json'), {
      name: 'legacy',
      projectType: 'application',
      targets: { build: { executor: '@angular-devkit/build-angular:browser', options: {} } },
    });
    await expect(runShared(makeCtx({ cwd: ws, flags: {} }))).rejects.toThrow(
      'Name the apps with --app=<a,b> or pass --all',
    );
    await expect(runShared(makeCtx({ cwd: ws, flags: { app: 'nope' } }))).rejects.toThrow(
      /^nope: no such project/,
    );
    await runShared(makeCtx({ cwd: ws, flags: { app: 'legacy' } }));
    expect(readPj(ws, 'legacy').targets.build.options.stylePreprocessorOptions).toEqual({
      includePaths: ['libs/shared/styles'],
    });
    expect(fs.existsSync(path.join(ws, 'libs/shared/styles/_theme.scss'))).toBe(true);
  });
});
