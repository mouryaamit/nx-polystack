import * as fs from 'fs';
import * as path from 'path';

import { migrateArgs, runUpdate, UpdateDeps } from '../../src/cli/commands/update';
import { DEV_GITHUB_REPO, setInstallSourceForTests } from '../../src/cli/install-source';

import { fakeLocalPlugin, makeCtx, tmpDir, writeJson } from './helpers';

const DEV = { kind: 'github', repo: DEV_GITHUB_REPO } as const;

const SPEC = (v: string) => `github:example-org/private-plugin#v${v}`;

function workspace(version = '0.2.2') {
  const ws = tmpDir();
  fs.writeFileSync(path.join(ws, 'nx.json'), '{}');
  writeJson(path.join(ws, 'package.json'), {
    name: 'ws',
    devDependencies: { nx: '^17.0.0', '@mouryaamit/nx-polystack': SPEC(version) },
  });
  fs.writeFileSync(path.join(ws, 'package-lock.json'), 'LOCK-BEFORE');
  return ws;
}

function deps(over: Partial<UpdateDeps> = {}) {
  const calls: string[] = [];
  const d: UpdateDeps = {
    exec: (cmd, args, cwd) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      // Like npm: rewrite the spec in package.json and install the plugin.
      const pkgPath = path.join(cwd, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const field = args.includes('--save-prod') ? 'dependencies' : 'devDependencies';
      const other = field === 'dependencies' ? 'devDependencies' : 'dependencies';
      delete pkg[other]?.['@mouryaamit/nx-polystack'];
      pkg[field] = {
        ...pkg[field],
        '@mouryaamit/nx-polystack': args[1].split('@mouryaamit/nx-polystack@')[1],
      };
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      fakeLocalPlugin(cwd, '0.3.0');
      fs.writeFileSync(path.join(cwd, 'package-lock.json'), 'LOCK-AFTER');
    },
    gitStatus: () => '',
    runLocalMigrate: (cliPath, from, to) => {
      expect(cliPath).toMatch(/nx-polystack[\\/]dist[\\/]bin[\\/]cli\.js$/);
      calls.push(`migrate ${from} ${to}`);
      return 0;
    },
    ...over,
  };
  return { calls, d };
}

const readPkg = (ws: string) => JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'));

describe('pstack update', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('fails outside a workspace', async () => {
    await expect(runUpdate(makeCtx({ cwd: tmpDir() }), deps().d)).rejects.toThrow(/no nx\.json/);
  });

  it('bumps the pin, installs, then runs migrations from the new local plugin', async () => {
    const ws = workspace();
    const { calls, d } = deps();
    expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(0);
    expect(readPkg(ws).devDependencies['@mouryaamit/nx-polystack']).toBe(SPEC('0.3.0'));
    expect(calls).toEqual([
      `npm install @mouryaamit/nx-polystack@${SPEC('0.3.0')} --save-dev`,
      'migrate 0.2.2 0.3.0',
    ]);
  });

  it('moves a pin on the earlier repo name to the development repo (v0.38.2)', async () => {
    const ws = workspace();
    writeJson(path.join(ws, 'package.json'), {
      name: 'ws',
      devDependencies: { '@mouryaamit/nx-polystack': 'github:mouryaamit/nx-polystack#v0.2.2' },
    });
    const { calls, d } = deps();
    expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(0);
    expect(calls).toEqual([
      `npm install @mouryaamit/nx-polystack@${SPEC('0.3.0')} --save-dev`,
      'migrate 0.2.2 0.3.0',
    ]);
  });

  it('an npm build moves a range pin to an exact npm version, from the installed version (NX-51)', async () => {
    setInstallSourceForTests({ kind: 'npm' });
    try {
      const ws = workspace();
      writeJson(path.join(ws, 'package.json'), {
        name: 'ws',
        devDependencies: { '@mouryaamit/nx-polystack': '^0.2.2' },
      });
      fakeLocalPlugin(ws, '0.2.5');
      fs.mkdirSync(path.join(ws, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, '.github/workflows/ci.yml'),
        'env: ${{ secrets.PSTACK_REPO_TOKEN }}\n',
      );
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const { calls, d } = deps();
      expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain(
        '.github/workflows/ci.yml still install it from GitHub',
      );
      expect(calls).toEqual([
        'npm install @mouryaamit/nx-polystack@0.3.0 --save-dev --save-exact',
        'migrate 0.2.5 0.3.0',
      ]);
      expect(readPkg(ws).devDependencies['@mouryaamit/nx-polystack']).toBe('0.3.0');
    } finally {
      setInstallSourceForTests(DEV);
    }
  });

  it('an npm build migrates a pin it cannot read from the installed version (NX-59)', async () => {
    setInstallSourceForTests({ kind: 'npm' });
    try {
      const ws = workspace();
      writeJson(path.join(ws, 'package.json'), {
        name: 'ws',
        devDependencies: { '@mouryaamit/nx-polystack': 'github:someone/private-fork#v0.2.2' },
      });
      fakeLocalPlugin(ws, '0.2.5');
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const { calls, d } = deps();
      expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain(
        '"github:someone/private-fork#v0.2.2" is not a version pin; migrating from the installed v0.2.5',
      );
      expect(calls).toEqual([
        'npm install @mouryaamit/nx-polystack@0.3.0 --save-dev --save-exact',
        'migrate 0.2.5 0.3.0',
      ]);
      expect(readPkg(ws).devDependencies['@mouryaamit/nx-polystack']).toBe('0.3.0');
    } finally {
      setInstallSourceForTests(DEV);
    }
  });

  it('rewrites an unreadable pin already on the target, without migrations (NX-59)', async () => {
    const ws = workspace();
    writeJson(path.join(ws, 'package.json'), {
      name: 'ws',
      devDependencies: { '@mouryaamit/nx-polystack': 'latest' },
    });
    fakeLocalPlugin(ws, '0.3.0');
    const { calls, d } = deps();
    expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(0);
    expect(calls).toEqual([`npm install @mouryaamit/nx-polystack@${SPEC('0.3.0')} --save-dev`]);
    expect(readPkg(ws).devDependencies['@mouryaamit/nx-polystack']).toBe(SPEC('0.3.0'));
  });

  it('refuses an unreadable pin when the plugin is not installed', async () => {
    const ws = workspace();
    writeJson(path.join(ws, 'package.json'), {
      name: 'ws',
      devDependencies: { '@mouryaamit/nx-polystack': 'github:someone/private-fork#v0.2.2' },
    });
    await expect(runUpdate(makeCtx({ cwd: ws }), deps().d)).rejects.toThrow(
      /no installed copy was found/,
    );
  });

  it('uses --save-prod when the plugin is in dependencies', async () => {
    const ws = workspace();
    writeJson(path.join(ws, 'package.json'), {
      name: 'ws',
      dependencies: { '@mouryaamit/nx-polystack': SPEC('0.2.2') },
    });
    const { calls, d } = deps();
    expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(0);
    expect(calls[0]).toBe(`npm install @mouryaamit/nx-polystack@${SPEC('0.3.0')} --save-prod`);
    expect(readPkg(ws).dependencies['@mouryaamit/nx-polystack']).toBe(SPEC('0.3.0'));
  });

  it('is a noop when already on the target', async () => {
    const ws = workspace('0.3.0');
    const { calls, d } = deps();
    expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses a dirty tree unless --allow-dirty', async () => {
    const ws = workspace();
    const { d } = deps({ gitStatus: () => ' M package.json\n' });
    await expect(runUpdate(makeCtx({ cwd: ws }), d)).rejects.toThrow(/uncommitted changes/);
    expect(await runUpdate(makeCtx({ cwd: ws, flags: { allowDirty: true } }), d)).toBe(0);
  });

  it('treats a non-git folder as clean', async () => {
    const ws = workspace();
    const { d } = deps({ gitStatus: () => null });
    expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(0);
  });

  it('--dry-run works in a dirty tree', async () => {
    const ws = workspace();
    const { calls, d } = deps({ gitStatus: () => ' M package.json\n' });
    expect(await runUpdate(makeCtx({ cwd: ws, dryRun: true }), d)).toBe(0);
    expect(calls).toEqual([]);
  });

  it('--dry-run changes nothing', async () => {
    const ws = workspace();
    const { calls, d } = deps();
    expect(await runUpdate(makeCtx({ cwd: ws, dryRun: true }), d)).toBe(0);
    expect(readPkg(ws).devDependencies['@mouryaamit/nx-polystack']).toBe(SPEC('0.2.2'));
    expect(calls).toEqual([]);
  });

  it('restores package.json and lockfile when npm install fails', async () => {
    const ws = workspace();
    const before = fs.readFileSync(path.join(ws, 'package.json'), 'utf8');
    const { d } = deps({
      exec: (_c, _a, cwd) => {
        fs.writeFileSync(path.join(cwd, 'package-lock.json'), 'HALF-WRITTEN');
        throw new Error('ERESOLVE');
      },
    });
    await expect(runUpdate(makeCtx({ cwd: ws }), d)).rejects.toThrow(
      /npm install failed.*restored/s,
    );
    expect(fs.readFileSync(path.join(ws, 'package.json'), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(ws, 'package-lock.json'), 'utf8')).toBe('LOCK-BEFORE');
  });

  it('propagates a failing migration exit code', async () => {
    const ws = workspace();
    const { d } = deps({ runLocalMigrate: () => 1 });
    expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(1);
  });

  it('explains how to recover when migrations fail', async () => {
    const ws = workspace();
    const errSpy = jest.spyOn(console, 'error');
    const { d } = deps({ runLocalMigrate: () => 1 });
    expect(await runUpdate(makeCtx({ cwd: ws }), d)).toBe(1);
    const msg = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(msg).toContain('already on v0.3.0');
    expect(msg).toContain('migrations from v0.2.2 did not all apply');
    expect(msg).toContain('git checkout -- . && npm install');
    expect(msg).toContain('pstack update');
    expect(msg).toContain('npx pstack _migrate --from=0.2.2 --to=0.3.0');
  });

  it('passes --verbose to the child migrate', async () => {
    const ws = workspace();
    const seen: Array<boolean | undefined> = [];
    const { d } = deps({
      runLocalMigrate: (_c, _f, _t, _w, verbose) => {
        seen.push(verbose);
        return 0;
      },
    });
    await runUpdate(makeCtx({ cwd: ws, verbose: true }), d);
    expect(seen).toEqual([true]);
  });

  it('migrateArgs includes --verbose only when asked', () => {
    expect(migrateArgs('0.2.2', '0.3.0')).toEqual(['_migrate', '--from=0.2.2', '--to=0.3.0']);
    expect(migrateArgs('0.2.2', '0.3.0', true)).toEqual([
      '_migrate',
      '--from=0.2.2',
      '--to=0.3.0',
      '--verbose',
    ]);
  });

  it('restores files and removes a new lockfile when the installed version is wrong', async () => {
    const ws = workspace();
    fs.rmSync(path.join(ws, 'package-lock.json'));
    const before = fs.readFileSync(path.join(ws, 'package.json'), 'utf8');
    const base = deps().d;
    const { d } = deps({
      exec: (c, a, cwd) => {
        base.exec(c, a, cwd);
        fakeLocalPlugin(cwd, '0.2.9');
      },
    });
    await expect(runUpdate(makeCtx({ cwd: ws }), d)).rejects.toThrow(
      /found v0\.2\.9.*restored.*run npm install to resync/s,
    );
    expect(fs.readFileSync(path.join(ws, 'package.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(ws, 'package-lock.json'))).toBe(false);
  });

  it('restores the lockfile when the installed version is wrong', async () => {
    const ws = workspace();
    const base = deps().d;
    const { d } = deps({
      exec: (c, a, cwd) => {
        base.exec(c, a, cwd);
        fakeLocalPlugin(cwd, '0.2.9');
      },
    });
    await expect(runUpdate(makeCtx({ cwd: ws }), d)).rejects.toThrow(/restored/);
    expect(fs.readFileSync(path.join(ws, 'package-lock.json'), 'utf8')).toBe('LOCK-BEFORE');
  });

  it('rejects --to without a value', async () => {
    const ws = workspace();
    await expect(runUpdate(makeCtx({ cwd: ws, flags: { to: true } }), deps().d)).rejects.toThrow(
      /--to requires a version/,
    );
  });

  it('reports a missing package.json', async () => {
    const ws = tmpDir();
    fs.writeFileSync(path.join(ws, 'nx.json'), '{}');
    await expect(runUpdate(makeCtx({ cwd: ws }), deps().d)).rejects.toThrow(/no package\.json at/);
  });

  it('tolerates a UTF-8 BOM in package.json', async () => {
    const ws = workspace();
    const p = path.join(ws, 'package.json');
    fs.writeFileSync(p, '\uFEFF' + fs.readFileSync(p, 'utf8'));
    expect(await runUpdate(makeCtx({ cwd: ws, dryRun: true }), deps().d)).toBe(0);
  });

  describe('target version as an argument (NX-65)', () => {
    it('takes the version as a positional argument, like --to', async () => {
      const ws = workspace();
      const { calls, d } = deps();
      // The global CLI is older than the workspace: without the argument this would fail.
      const ctx = makeCtx({ cwd: ws, positionals: ['v0.3.0'], selfVersion: '0.1.0' });
      expect(await runUpdate(ctx, d)).toBe(0);
      expect(readPkg(ws).devDependencies['@mouryaamit/nx-polystack']).toBe(SPEC('0.3.0'));
      expect(calls).toContain('migrate 0.2.2 0.3.0');
    });

    it('accepts the same version given both ways', async () => {
      const ws = workspace();
      const ctx = makeCtx({ cwd: ws, positionals: ['0.3.0'], flags: { to: 'v0.3.0' } });
      expect(await runUpdate(ctx, deps().d)).toBe(0);
    });

    it('rejects two different versions, more than one argument, or a non-version', async () => {
      const ws = workspace();
      await expect(
        runUpdate(makeCtx({ cwd: ws, positionals: ['0.3.0'], flags: { to: '0.4.0' } }), deps().d),
      ).rejects.toThrow('"0.3.0" and --to=0.4.0 name different versions');
      await expect(
        runUpdate(makeCtx({ cwd: ws, positionals: ['0.3.0', '0.4.0'] }), deps().d),
      ).rejects.toThrow('pstack update takes one version, got: 0.3.0 0.4.0');
      await expect(
        runUpdate(makeCtx({ cwd: ws, positionals: ['latest'] }), deps().d),
      ).rejects.toThrow('"latest" is not a valid version');
      expect(readPkg(ws).devDependencies['@mouryaamit/nx-polystack']).toBe(SPEC('0.2.2'));
    });
  });
});
