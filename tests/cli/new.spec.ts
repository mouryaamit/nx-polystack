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

  it('--angular=16 starts the workspace on Angular 16; other majors are refused', async () => {
    const cwd = tmpDir();
    await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, angular: '16' } }),
      recorder().deps,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'ws', 'package.json'), 'utf8'));
    expect(pkg.dependencies['@angular/core']).toBe('~16.2.12');
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~16.2.12');
    expect(pkg.devDependencies.typescript).toBe('~5.1.6');

    for (const angular of ['22', true]) {
      await expect(
        runNew(
          makeCtx({ cwd: tmpDir(), positionals: ['ws'], flags: { skipFormat: true, angular } }),
          recorder().deps,
        ),
      ).rejects.toThrow(/--angular must be one of 14, 15, 16, 17, 18, 19, 20, 21/);
    }
  });

  it('--angular=17 moves the workspace to Nx 18 with typescript-eslint 7', async () => {
    const cwd = tmpDir();
    await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, angular: '17' } }),
      recorder().deps,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'ws', 'package.json'), 'utf8'));
    expect(pkg.dependencies['@angular/core']).toBe('~17.3.12');
    expect(pkg.dependencies['zone.js']).toBe('~0.14.0');
    for (const name of ['nx', '@nx/devkit', '@nx/eslint', '@nx/eslint-plugin', '@nx/angular']) {
      expect(pkg.devDependencies[name]).toBe('~18.3.5');
    }
    expect(pkg.devDependencies['@typescript-eslint/parser']).toBe('^7.18.0');
    expect(pkg.devDependencies['eslint-plugin-unused-imports']).toBe('^3.2.0');
    expect(pkg.devDependencies.typescript).toBe('~5.4.5');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~17.3.0');
  });

  it('--angular=18 moves the workspace to Nx 19.8 with TypeScript 5.5', async () => {
    const cwd = tmpDir();
    await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, angular: '18' } }),
      recorder().deps,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'ws', 'package.json'), 'utf8'));
    expect(pkg.dependencies['@angular/core']).toBe('~18.2.14');
    expect(pkg.dependencies['zone.js']).toBe('~0.14.0');
    for (const name of ['nx', '@nx/devkit', '@nx/eslint', '@nx/eslint-plugin', '@nx/angular']) {
      expect(pkg.devDependencies[name]).toBe('~19.8.14');
    }
    expect(pkg.devDependencies['@typescript-eslint/parser']).toBe('^7.18.0');
    expect(pkg.devDependencies['eslint-plugin-unused-imports']).toBe('^3.2.0');
    expect(pkg.devDependencies.typescript).toBe('~5.5.4');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~18.4.3');
  });

  it('--angular=19 moves the workspace to Nx 20.8 with TypeScript 5.8', async () => {
    const cwd = tmpDir();
    await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, angular: '19' } }),
      recorder().deps,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'ws', 'package.json'), 'utf8'));
    expect(pkg.dependencies['@angular/core']).toBe('~19.2.25');
    expect(pkg.dependencies['zone.js']).toBe('~0.15.0');
    for (const name of ['nx', '@nx/devkit', '@nx/eslint', '@nx/eslint-plugin', '@nx/angular']) {
      expect(pkg.devDependencies[name]).toBe('~20.8.4');
    }
    expect(pkg.devDependencies.typescript).toBe('~5.8.3');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~19.8.1');
  });

  it('--angular=20 moves the workspace to Nx 21.6 with TypeScript 5.9', async () => {
    const cwd = tmpDir();
    await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, angular: '20' } }),
      recorder().deps,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'ws', 'package.json'), 'utf8'));
    expect(pkg.dependencies['@angular/core']).toBe('~20.3.34');
    expect(pkg.dependencies['zone.js']).toBe('~0.15.0');
    for (const name of ['nx', '@nx/devkit', '@nx/eslint', '@nx/eslint-plugin', '@nx/angular']) {
      expect(pkg.devDependencies[name]).toBe('~21.6.11');
    }
    expect(pkg.devDependencies.typescript).toBe('~5.9.3');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~20.7.0');
  });

  it('--standalone saves nx.json pstack.angular.style', async () => {
    const cwd = tmpDir();
    await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, standalone: true } }),
      recorder().deps,
    );
    const nx = JSON.parse(fs.readFileSync(path.join(cwd, 'ws', 'nx.json'), 'utf8'));
    expect(nx.pstack.angular).toEqual({ style: 'standalone' });
  });

  it('--angular=21 moves the workspace to Nx 22.7 and Node 22', async () => {
    const cwd = tmpDir();
    await runNew(
      makeCtx({ cwd, positionals: ['ws'], flags: { skipFormat: true, angular: '21' } }),
      recorder().deps,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'ws', 'package.json'), 'utf8'));
    expect(pkg.dependencies['@angular/core']).toBe('~21.2.25');
    expect(pkg.dependencies['zone.js']).toBe('~0.16.0');
    for (const name of ['nx', '@nx/devkit', '@nx/eslint', '@nx/eslint-plugin', '@nx/angular']) {
      expect(pkg.devDependencies[name]).toBe('~22.7.12');
    }
    expect(pkg.devDependencies.typescript).toBe('~5.9.3');
    expect(pkg.devDependencies['@types/node']).toBe('~22.10.0');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('^21.0.0');
    expect(fs.readFileSync(path.join(cwd, 'ws', '.nvmrc'), 'utf8')).toBe('22\n');
    const base = JSON.parse(fs.readFileSync(path.join(cwd, 'ws', 'tsconfig.base.json'), 'utf8'));
    expect(base.compilerOptions.moduleResolution).toBe('bundler');
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
