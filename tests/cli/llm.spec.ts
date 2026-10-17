import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { COMMANDS } from '../../src/cli/commands';
import { runLlm } from '../../src/cli/commands/llm';
import { helpText } from '../../src/cli/help';
import { assertLocalSupports, MIN_LOCAL_VERSION, WORKSPACE_COMMANDS } from '../../src/cli/launcher';
import { CliError } from '../../src/cli/types';

import { makeCtx, tmpDir, writeJson } from './helpers';

function workspace(): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), {
    name: '@acme/source',
    devDependencies: { nx: '17.0.6' },
  });
  writeJson(path.join(ws, 'libs/shared/util/project.json'), {
    name: 'shared-util',
    tags: ['type:ts'],
  });
  return ws;
}

describe('pstack llm', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('requires a workspace', async () => {
    await expect(runLlm(makeCtx({ cwd: tmpDir() }))).rejects.toThrow(
      /no nx.json found[\s\S]*pstack llm/,
    );
  });

  it('writes nothing with --dry-run', async () => {
    const ws = workspace();
    expect(await runLlm(makeCtx({ cwd: ws, dryRun: true }))).toBe(0);
    expect(fs.existsSync(path.join(ws, 'CLAUDE.md'))).toBe(false);
  });

  it('writes the requested providers from a subdirectory', async () => {
    const ws = workspace();
    await runLlm(makeCtx({ cwd: path.join(ws, 'libs'), flags: { providers: 'claude,codex' } }));
    expect(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toContain('`shared-util`');
    expect(fs.existsSync(path.join(ws, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(ws, '.github/copilot-instructions.md'))).toBe(false);
  });

  it('writes all three by default and is a no-op the second time', async () => {
    const ws = workspace();
    await runLlm(makeCtx({ cwd: ws }));
    const info = jest.spyOn(logger, 'info');
    info.mockClear();
    await runLlm(makeCtx({ cwd: ws }));
    expect(info).toHaveBeenCalledWith('Nothing to generate.');
    expect(fs.existsSync(path.join(ws, '.github/copilot-instructions.md'))).toBe(true);
  });

  it('rejects unknown providers as a usage error', async () => {
    const err = runLlm(makeCtx({ cwd: workspace(), flags: { providers: 'gemini' } }));
    await expect(err).rejects.toBeInstanceOf(CliError);
    await expect(err).rejects.toThrow(/unknown provider "gemini"/);
  });

  it('is registered, delegated from the workspace root, needs 0.7.0 locally, and is in the help', () => {
    expect(COMMANDS['llm']).toBeDefined();
    expect(WORKSPACE_COMMANDS.has('llm')).toBe(true);
    expect(MIN_LOCAL_VERSION['llm']).toBe('0.7.0');
    expect(() => assertLocalSupports('llm', '0.6.1')).toThrow(
      'pstack llm needs nx-polystack >= 0.7.0 in this workspace (found 0.6.1). ' +
        'Run "pstack update" first.',
    );
    expect(() => assertLocalSupports('llm', '0.7.0')).not.toThrow();
    const help = helpText('0.0.0');
    expect(help).toContain('OPTIONS — llm');
    expect(help).toContain('pstack llm --providers=claude,agents');
  });
});
