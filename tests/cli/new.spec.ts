import * as fs from 'fs';
import * as path from 'path';

import { NewDeps, runNew } from '../../src/cli/commands/new';

import { makeCtx, tmpDir } from './helpers';

function recorder(git = true, failOn?: (cmd: string, args: string[]) => boolean) {
  const calls: Array<[string, string[]]> = [];
  const deps: NewDeps = {
    exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (failOn?.(cmd, args)) throw new Error('boom');
    },
    hasGit: () => git,
  };
  return { calls, deps };
}

describe('pstack new', () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('requires a directory', async () => {
    await expect(runNew(makeCtx({ cwd: tmpDir() }), recorder().deps)).rejects.toThrow(
      /target directory is required/,
    );
  });

  it('rejects a non-empty directory', async () => {
    const cwd = tmpDir();
    fs.mkdirSync(path.join(cwd, 'ws'));
    fs.writeFileSync(path.join(cwd, 'ws', 'x.txt'), 'x');
    await expect(runNew(makeCtx({ cwd, positionals: ['ws'] }), recorder().deps)).rejects.toThrow(
      /is not empty/,
    );
  });

  it('refuses to nest inside a workspace without --force', async () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, 'nx.json'), '{}');
    await expect(
      runNew(makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true } }), recorder().deps),
    ).rejects.toThrow(/inside an existing Nx workspace/);
  });

  it('writes the workspace, pins the plugin, installs and commits', async () => {
    const cwd = tmpDir();
    const { calls, deps } = recorder();
    const code = await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, baseBranch: 'main' } }),
      deps,
    );
    expect(code).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'ws', 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@mouryaamit/nx-polystack']).toBe(
      'github:example-org/private-plugin#v0.3.0',
    );
    expect(fs.existsSync(path.join(cwd, 'ws', 'nx.json'))).toBe(true);
    expect(calls).toEqual([
      ['git', ['init', '-b', 'main']],
      ['npm', ['install']],
      ['git', ['add', '-A']],
      ['git', ['commit', '--no-verify', '-m', 'chore: initial polystack workspace']],
    ]);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/cd ws/);
  });

  it('honours --skip-install and --skip-git', async () => {
    const cwd = tmpDir();
    const { calls, deps } = recorder();
    await runNew(
      makeCtx({
        cwd,
        positionals: ['ws'],
        flags: { skipFormat: true, skipInstall: true, skipGit: true },
      }),
      deps,
    );
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(cwd, 'ws', 'package.json'))).toBe(true);
  });

  it('skips git when git is missing', async () => {
    const cwd = tmpDir();
    const { calls, deps } = recorder(false);
    await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, skipInstall: true } }),
      deps,
    );
    expect(calls).toEqual([]);
  });

  it('--dry-run creates nothing and runs nothing', async () => {
    const cwd = tmpDir();
    const { calls, deps } = recorder();
    await runNew(makeCtx({ cwd, positionals: ['ws'], dryRun: true }), deps);
    expect(fs.existsSync(path.join(cwd, 'ws'))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('rejects an invalid --baseBranch before generating', async () => {
    const cwd = tmpDir();
    await expect(
      runNew(
        makeCtx({ cwd, positionals: ['ws'], flags: { baseBranch: 'a b; rm' } }),
        recorder().deps,
      ),
    ).rejects.toThrow(/not a valid branch name/);
    expect(fs.existsSync(path.join(cwd, 'ws'))).toBe(false);
  });

  it('rejects a target that is a file', async () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, 'ws'), 'x');
    await expect(runNew(makeCtx({ cwd, positionals: ['ws'] }), recorder().deps)).rejects.toThrow(
      /is not a directory/,
    );
  });

  it('continues without git when git init fails', async () => {
    const cwd = tmpDir();
    const { calls, deps } = recorder(true, (c, a) => c === 'git' && a[0] === 'init');
    const code = await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true } }),
      deps,
    );
    expect(code).toBe(0);
    expect(calls.map((c) => c[0] + ' ' + c[1][0])).toEqual(['git init', 'npm install']);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/git init failed.*continuing without git/),
    );
  });

  it('reports npm install failure with files written', async () => {
    const cwd = tmpDir();
    const { deps } = recorder(true, (c) => c === 'npm');
    await expect(
      runNew(makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true } }), deps),
    ).rejects.toThrow(/Files were written/);
  });

  it('warns but returns 0 when the initial commit fails', async () => {
    const cwd = tmpDir();
    const { deps } = recorder(true, (c, a) => c === 'git' && a[0] === 'commit');
    const code = await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, skipInstall: true } }),
      deps,
    );
    expect(code).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/initial commit failed/));
  });

  it('--force allows creating inside a workspace', async () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, 'nx.json'), '{}');
    const code = await runNew(
      makeCtx({
        cwd,
        positionals: ['ws'],
        flags: { skipFormat: true, skipInstall: true, skipGit: true, force: true },
      }),
      recorder().deps,
    );
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(cwd, 'ws', 'package.json'))).toBe(true);
  });

  it('omits the cd line when creating in the current directory', async () => {
    const cwd = tmpDir();
    await runNew(
      makeCtx({
        cwd,
        positionals: ['.'],
        flags: { skipFormat: true, skipInstall: true, skipGit: true },
      }),
      recorder().deps,
    );
    expect(logSpy.mock.calls.flat().join('\n')).not.toMatch(/cd /);
  });

  describe('--infra', () => {
    const run = async (flags: Record<string, string | boolean>) => {
      const cwd = tmpDir();
      await runNew(
        makeCtx({
          cwd,
          positionals: ['ws'],
          flags: { skipFormat: true, skipInstall: true, skipGit: true, ...flags },
        }),
        recorder().deps,
      );
      return (f: string) => fs.existsSync(path.join(cwd, 'ws', f));
    };

    it('runs every infra part by default, with GitHub Actions', async () => {
      const has = await run({});
      for (const f of [
        'CONTRIBUTING.md',
        '.github/workflows/ci.yml',
        '.github/workflows/dependency-upgrade.yml',
        'knip.json',
        '.husky/pre-push',
      ]) {
        expect(has(f)).toBe(true);
      }
      expect(has('Jenkinsfile')).toBe(false);
    });

    it('--infra=none skips it; --infra (bare) and --infra=all run it all', async () => {
      expect((await run({ infra: 'none' }))('CONTRIBUTING.md')).toBe(false);
      expect((await run({ infra: true }))('knip.json')).toBe(true);
      expect((await run({ infra: 'all' }))('knip.json')).toBe(true);
    });

    it('a new workspace has no Flutter yet; --flutter=on adds the setup step', async () => {
      const cwd = tmpDir();
      const ci = (dir: string) =>
        fs.readFileSync(path.join(dir, 'ws', '.github/workflows/ci.yml'), 'utf8');
      await runNew(
        makeCtx({
          cwd,
          positionals: ['ws'],
          flags: { skipFormat: true, skipInstall: true, skipGit: true },
        }),
        recorder().deps,
      );
      expect(ci(cwd)).not.toContain('flutter-action');
      const on = tmpDir();
      await runNew(
        makeCtx({
          cwd: on,
          positionals: ['ws'],
          flags: { skipFormat: true, skipInstall: true, skipGit: true, flutter: 'on' },
        }),
        recorder().deps,
      );
      expect(ci(on)).toContain('subosito/flutter-action@v2');
    });

    it('--infra=docs,ci --ci=jenkins writes just those', async () => {
      const has = await run({ infra: 'docs,ci', ci: 'jenkins' });
      expect(has('CONTRIBUTING.md')).toBe(true);
      expect(has('Jenkinsfile')).toBe(true);
      expect(has('.github/workflows/ci.yml')).toBe(false);
      expect(has('knip.json')).toBe(false);
    });

    it.each([
      [{ infra: 'docs,bogus' }, /unknown part "bogus" in --infra/],
      [{ ci: 'gitlab' }, /unknown CI provider "gitlab"/],
      [{ ciCache: 'maybe' }, /--ci-cache must be true or false/],
      [{ flutter: 'maybe' }, /--flutter must be auto, on or off/],
    ])('rejects %j before creating anything', async (flags, message) => {
      const cwd = tmpDir();
      await expect(
        runNew(makeCtx({ cwd, positionals: ['ws'], flags }), recorder().deps),
      ).rejects.toThrow(message);
      expect(fs.existsSync(path.join(cwd, 'ws'))).toBe(false);
    });
  });

  it('dry run omits git lines when git is missing', async () => {
    await runNew(
      makeCtx({ cwd: tmpDir(), positionals: ['ws'], dryRun: true }),
      recorder(false).deps,
    );
    expect(logSpy.mock.calls.flat().join('\n')).not.toMatch(/Would run: git/);
  });
});
