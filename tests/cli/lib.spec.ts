import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { COMMANDS } from '../../src/cli/commands';
import { runLib } from '../../src/cli/commands/lib';
import { helpText } from '../../src/cli/help';
import { assertLocalSupports, WORKSPACE_COMMANDS } from '../../src/cli/launcher';
import { CliError } from '../../src/cli/types';

import { makeCtx, tmpDir, writeJson } from './helpers';

/** A minimal on-disk Nx workspace. */
function workspace(): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), {
    name: '@acme/source',
    devDependencies: { nx: '17.0.6' },
  });
  writeJson(path.join(ws, 'tsconfig.base.json'), { compilerOptions: { paths: {} } });
  return ws;
}

describe('pstack lib', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('requires --name', async () => {
    await expect(runLib(makeCtx({ cwd: workspace(), flags: { type: 'ts' } }))).rejects.toThrow(
      /--name is required/,
    );
  });

  it('requires --type', async () => {
    const err = runLib(makeCtx({ cwd: workspace(), flags: { name: 'util' } }));
    await expect(err).rejects.toBeInstanceOf(CliError);
    await expect(err).rejects.toThrow(/--type is required/);
  });

  it('requires a workspace', async () => {
    await expect(
      runLib(makeCtx({ cwd: tmpDir(), flags: { name: 'util', type: 'ts' } })),
    ).rejects.toThrow(/no nx.json found[\s\S]*pstack lib/);
  });

  it('writes nothing with --dry-run', async () => {
    const ws = workspace();
    const code = await runLib(
      makeCtx({ cwd: ws, dryRun: true, flags: { name: 'brand', type: 'assets' } }),
    );
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(ws, 'libs'))).toBe(false);
  });

  it('generates the lib from a subdirectory, passing scope and tags', async () => {
    const ws = workspace();
    const sub = path.join(ws, 'apps');
    fs.mkdirSync(sub);
    await runLib(
      makeCtx({
        cwd: sub,
        flags: { name: 'theme', type: 'styles', scope: 'web', tags: 'team:core, layer:ui' },
      }),
    );
    const pj = JSON.parse(fs.readFileSync(path.join(ws, 'libs/web/theme/project.json'), 'utf8'));
    expect(pj.name).toBe('web-theme');
    expect(pj.tags).toEqual(['scope:web', 'type:styles', 'platform:web', 'team:core', 'layer:ui']);
    expect(fs.existsSync(path.join(ws, 'libs/web/theme/src/_index.scss'))).toBe(true);
  });

  it('surfaces generator errors', async () => {
    await expect(
      runLib(makeCtx({ cwd: workspace(), flags: { name: 'core', type: 'ios-native' } })),
    ).rejects.toThrow(/planned for a later release/);
  });

  it('is registered, runs from the workspace root when delegated, and is in the help', () => {
    expect(COMMANDS['lib']).toBeDefined();
    expect(WORKSPACE_COMMANDS.has('lib')).toBe(true);
    const help = helpText('0.0.0');
    expect(help).toContain('OPTIONS — lib');
    expect(help).toContain('pstack lib --type=angular --name=ui');
  });
});

describe('pstack lib --dir', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('puts the lib in libs/<scope>/<dir>/<name>', async () => {
    const ws = workspace();
    await runLib(makeCtx({ cwd: ws, flags: { type: 'flutter', name: 'util', dir: 'forms' } }));
    expect(fs.existsSync(path.join(ws, 'libs/flutter/forms/util/project.json'))).toBe(true);
  });

  it('checks --dir before looking for a workspace, and needs 0.19.0 locally', async () => {
    const outside = tmpDir();
    const bad = runLib(makeCtx({ cwd: outside, flags: { type: 'ts', name: 'u', dir: 'a/b/c' } }));
    await expect(bad).rejects.toBeInstanceOf(CliError);
    await expect(bad).rejects.toThrow(/^--dir="a\/b\/c" is too deep: at most 2 folders/);
    await expect(
      runLib(makeCtx({ cwd: outside, flags: { type: 'ts', name: 'u', dir: true } })),
    ).rejects.toThrow('--dir needs a value');
    expect(() => assertLocalSupports('lib', '0.18.1', { dir: 'forms' })).toThrow(
      'pstack lib --dir needs nx-polystack >= 0.19.0',
    );
    expect(helpText('0.19.0')).toContain('pstack lib --type=angular --name=ui --dir=forms');
  });
});
