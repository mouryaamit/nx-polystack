import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';
import { FsTree, flushChanges } from 'nx/src/generators/tree';

import { runApp } from '../../src/cli/commands/app';
import { assertLocalSupports } from '../../src/cli/launcher';
import { askValid, scriptedPrompter } from '../../src/cli/prompt';
import { CliError } from '../../src/cli/types';
import appGenerator from '../../src/generators/app/generator';

import { makeCtx, tmpDir, writeJson } from './helpers';

function workspace(): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), { name: '@acme/source', scripts: {} });
  writeJson(path.join(ws, 'tsconfig.base.json'), { compilerOptions: { paths: {} } });
  return ws;
}

const readJson = (ws: string, f: string) => JSON.parse(fs.readFileSync(path.join(ws, f), 'utf8'));

describe('pstack app --from (NX-66)', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    jest.spyOn(logger, 'info').mockImplementation((m) => void out.push(String(m)));
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation((m) => void out.push(String(m)));
  });
  afterEach(() => jest.restoreAllMocks());

  async function withWeb(): Promise<string> {
    const ws = workspace();
    // The generator directly: no install task (npm is not reachable in tests).
    const tree = new FsTree(ws, false);
    await appGenerator(tree, { name: 'web', type: 'angular', baseHref: '/web/' });
    flushChanges(ws, tree.listChanges());
    fs.writeFileSync(
      path.join(ws, 'environments/web/environment.uat.ts'),
      "export const environment = { production: false, apiUrl: 'https://uat.example.com' };\n",
    );
    fs.writeFileSync(path.join(ws, 'apps/web/notes.log'), 'x');
    fs.writeFileSync(path.join(ws, '.gitignore'), '*.log\n');
    return ws;
  }

  it('without a terminal: takes the flags and defaults, and needs --name', async () => {
    const ws = await withWeb();
    await expect(
      runApp(makeCtx({ cwd: ws, flags: { from: 'web' } }), { interactive: false }),
    ).rejects.toThrow(/--name is required with --from/);
    await runApp(
      makeCtx({ cwd: ws, flags: { from: 'web', name: 'partner', envs: 'prod', port: '4300' } }),
      { interactive: false },
    );
    const pj = readJson(ws, 'apps/partner/project.json');
    expect(pj.targets.serve.options.port).toBe(4300);
    expect(Object.keys(pj.targets.release.configurations)).toEqual(['dev', 'prod']);
    expect(pj.targets.release.configurations.prod.baseHref).toBe('/partner/');
    expect(fs.readFileSync(path.join(ws, 'environments/partner/environment.ts'), 'utf8')).toMatch(
      /envName: (''|"")/,
    );
    expect(fs.existsSync(path.join(ws, 'environments/partner/environment.uat.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'apps/partner/notes.log'))).toBe(false);
    expect(out.join('\n')).toContain('partner (apps/partner) from web');
  });

  it('asks for what was not given, with the base app as default, then confirms', async () => {
    const ws = await withWeb();
    const asked: string[] = [];
    await runApp(makeCtx({ cwd: ws, flags: { from: 'web', port: '4310' } }), {
      interactive: true,
      prompter: scriptedPrompter(
        ['Partner', 'partner', '', '', 'dev,uat', 'clear', '', 'y'],
        asked,
      ),
    });
    expect(asked).toEqual([
      'New app name',
      'New app name',
      "Folder under apps/ ('.' for apps/<name>)",
      'Base href of the release builds (none for none)',
      'Environments to keep (dev is always kept)',
      'CSP allowlist: keep or clear',
      'Tags (comma-separated)',
      'Create partner? (Y/n)',
    ]);
    expect(out).toContain('  kebab-case, e.g. partner-portal');
    const pj = readJson(ws, 'apps/partner/project.json');
    expect(pj.targets.serve.options.port).toBe(4310);
    expect(Object.keys(pj.targets.release.configurations)).toEqual(['dev', 'uat']);
    expect(pj.targets.release.configurations.uat.baseHref).toBe('/partner/');
    expect(pj.tags).toEqual(readJson(ws, 'apps/web/project.json').tags);
  });

  it('writes nothing when the confirmation is declined', async () => {
    const ws = await withWeb();
    await runApp(makeCtx({ cwd: ws, flags: { from: 'web', name: 'p', yes: false } }), {
      interactive: true,
      prompter: scriptedPrompter(['', '', '', '', '', '', 'n']),
    });
    expect(fs.existsSync(path.join(ws, 'apps/p'))).toBe(false);
    expect(out).toContain('Nothing was changed.');
  });

  it('--dry-run writes nothing', async () => {
    const ws = await withWeb();
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runApp(makeCtx({ cwd: ws, dryRun: true, flags: { from: 'web', name: 'p' } }), {
      interactive: false,
    });
    stdout.mockRestore();
    expect(fs.existsSync(path.join(ws, 'apps/p'))).toBe(false);
  });

  it('refuses flags that come from the base app, and bad values', async () => {
    const ws = await withWeb();
    const run = (flags: Record<string, string | boolean>) =>
      runApp(makeCtx({ cwd: ws, flags: { from: 'web', name: 'p', ...flags } }), {
        interactive: false,
      });
    await expect(run({ type: 'angular' })).rejects.toThrow(
      '--type does not apply with --from (the new app takes it from web).',
    );
    await expect(run({ envLayout: 'per-env' })).rejects.toThrow(/--env-layout does not apply/);
    await expect(run({ csp: 'drop' })).rejects.toThrow('--csp must be keep or clear.');
    await expect(run({ port: 'x' })).rejects.toThrow(/got x/);
    await expect(run({ envs: 'sit' })).rejects.toThrow(/web has no environment sit/);
    await expect(run({ from: 'nope' })).rejects.toBeInstanceOf(CliError);
    await expect(run({ from: true })).rejects.toThrow('--from needs a value');
  });

  it('--base-href=none drops the base href; needs plugin 1.2.0 locally', async () => {
    const ws = await withWeb();
    await runApp(
      makeCtx({ cwd: ws, flags: { from: 'web', name: 'p', baseHref: 'none', yes: true } }),
    );
    const pj = readJson(ws, 'apps/p/project.json');
    expect(pj.targets.release.configurations.prod.baseHref).toBeUndefined();
    expect(() => assertLocalSupports('app', '1.1.1', { from: 'web' })).toThrow(
      'pstack app --from needs nx-polystack >= 1.2.0',
    );
  });

  it('askValid gives up after three wrong answers', async () => {
    const said: string[] = [];
    await expect(
      askValid(
        scriptedPrompter(['a', 'b', 'c']),
        'Q',
        undefined,
        () => 'no',
        (l) => said.push(l),
      ),
    ).rejects.toThrow('no valid answer to "Q"; nothing was changed.');
    expect(said).toEqual(['  no', '  no', '  no']);
  });
});
