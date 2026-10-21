import * as fs from 'fs';
import * as path from 'path';

import { repairHttpClientModule, runUpgrade, UpgradeDeps } from '../../src/cli/commands/upgrade';
import { scriptedPrompter } from '../../src/cli/prompt';

import { makeCtx, tmpDir, writeJson } from './helpers';

type Pkg = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines?: Record<string, string>;
};

/** Angular that `nx migrate <nx>` installs (Nx 22 leaves Angular on 20, as in the walk). */
const NX_ANGULAR: Record<string, string> = {
  '18.3.5': '17.3.9',
  '19.8.14': '18.2.9',
  '20.8.4': '19.2.9',
  '21.6.11': '20.3.9',
  '22.7.12': '20.3.9',
};

const readPkg = (ws: string): Pkg =>
  JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'));
const writePkg = (ws: string, pkg: Pkg) => writeJson(path.join(ws, 'package.json'), pkg);

function workspace(angular: string, extra: Partial<Pkg['dependencies']> = {}): string {
  const ws = tmpDir('pstack-upgrade-');
  writeJson(path.join(ws, 'nx.json'), {});
  writePkg(ws, {
    dependencies: { '@angular/core': `~${angular}`, '@angular/common': `~${angular}`, ...extra },
    devDependencies: {
      nx: '17.0.6',
      '@angular-devkit/build-angular': `~${angular}`,
      '@angular/cli': `~${angular}`,
      '@angular/compiler-cli': `~${angular}`,
      '@angular-eslint/eslint-plugin': '~15.2.1',
      typescript: '~4.9.5',
    },
    engines: { node: '>=20.0.0 <21.0.0' },
  });
  fs.writeFileSync(path.join(ws, '.nvmrc'), '20\n');
  installCore(ws);
  return ws;
}

function installCore(ws: string): void {
  const v = readPkg(ws).dependencies['@angular/core'].replace(/^[~^]/, '');
  writeJson(path.join(ws, 'node_modules/@angular/core/package.json'), { version: v });
}

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

function fakeDeps(ws: string, over: Partial<UpgradeDeps> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const deps: UpgradeDeps = {
    exec(cmd, args, cwd, env) {
      calls.push({ cmd, args, cwd, env });
      const pkg = readPkg(ws);
      if (
        cmd === 'npx' &&
        args[0] === 'nx' &&
        args[1] === 'migrate' &&
        args[2] !== '--run-migrations'
      ) {
        const target = args[2];
        if (target.startsWith('@angular/core@')) {
          pkg.dependencies['@angular/core'] = target.slice('@angular/core@'.length);
        } else {
          pkg.devDependencies['nx'] = target;
          if (NX_ANGULAR[target]) pkg.dependencies['@angular/core'] = NX_ANGULAR[target];
        }
        writePkg(ws, pkg);
      } else if (cmd === 'npm' && args[0] === 'install' && args[1] === '--save-dev') {
        for (const spec of args.slice(2)) {
          const at = spec.lastIndexOf('@');
          pkg.devDependencies[spec.slice(0, at)] = spec.slice(at + 1);
        }
        writePkg(ws, pkg);
      } else if (cmd === 'npm' && args.length === 1 && args[0] === 'install') {
        installCore(ws);
      }
    },
    gitStatus: () => '',
    nodeMajor: () => 20,
    interactive: false,
    prompter: () => scriptedPrompter([]),
    log: (l) => void out.push(l),
    ...over,
  };
  return { deps, calls, out };
}

const line = (c: Call) => `${c.cmd} ${c.args.join(' ')}`;

describe('pstack upgrade angular (NX-76)', () => {
  it('15 → 16: nx migrate @angular/core on Nx 17, then the build packages and TypeScript', async () => {
    const ws = workspace('15.2.10');
    const { deps, calls } = fakeDeps(ws);
    expect(await runUpgrade(makeCtx({ cwd: ws, positionals: ['angular'] }), deps)).toBe(0);
    const run = calls.map(line);
    expect(run[0]).toBe('npx nx migrate @angular/core@16.2.12 --interactive=false');
    expect(run).toContain('npm install');
    expect(run).toContain(
      'npm install --save-dev @angular-devkit/build-angular@~16.2.12 @angular/cli@~16.2.12 ' +
        '@angular/compiler-cli@~16.2.12 @angular-eslint/eslint-plugin@~16.3.1 typescript@~5.1.6',
    );
    expect(run).toContain('npx nx run-many -t build lint');
    expect(run.slice(-2)).toEqual([
      'git add -A',
      'git commit -m chore: upgrade to Angular 16 (pstack upgrade angular)',
    ]);
    expect(readPkg(ws).devDependencies['typescript']).toBe('~5.1.6');
  });

  it('20 → 21: Node 22, second Angular pass, Ionic 9 through @ionic/migrate, Capacitor 8', async () => {
    const ws = workspace('20.3.9', { '@ionic/angular': '~8.7.11' });
    writePkg(ws, {
      ...readPkg(ws),
      devDependencies: { ...readPkg(ws).devDependencies, nx: '21.6.11' },
    });
    writeJson(path.join(ws, 'apps/mobile/package.json'), {
      dependencies: { '@capacitor/core': '^7.0.0', '@capacitor/android': '^7.0.0' },
      devDependencies: { '@capacitor/cli': '^7.0.0' },
    });
    fs.mkdirSync(path.join(ws, 'apps/mobile/android'), { recursive: true });

    const node20 = fakeDeps(ws);
    await expect(
      runUpgrade(makeCtx({ cwd: ws, positionals: ['angular'] }), node20.deps),
    ).rejects.toThrow(/runs on Node 22.*this is Node 20/);
    expect(node20.calls).toEqual([]);

    const { deps, calls } = fakeDeps(ws, { nodeMajor: () => 22 });
    await runUpgrade(
      makeCtx({ cwd: ws, positionals: ['angular'], flags: { skipCheck: true } }),
      deps,
    );
    const run = calls.map(line);
    expect(readPkg(ws).engines?.['node']).toBe('>=22.12.0 <23.0.0');
    expect(fs.readFileSync(path.join(ws, '.nvmrc'), 'utf8')).toBe('22\n');
    expect(run[0]).toBe('npx nx migrate 22.7.12 --interactive=false');
    expect(run).toContain('npx nx migrate @angular/core@21.2.24 --interactive=false');
    const ionic = calls.find((c) => c.args.includes('@ionic/migrate'));
    expect(ionic && line(ionic)).toBe('npx -y @ionic/migrate --force');
    expect(ionic?.env).toEqual({ CI: '1' });
    const mobile = JSON.parse(fs.readFileSync(path.join(ws, 'apps/mobile/package.json'), 'utf8'));
    expect(mobile.dependencies['@capacitor/core']).toBe('^8.0.0');
    expect(mobile.devDependencies['@capacitor/cli']).toBe('^8.0.0');
    expect(run).toContain(`npm install --prefix ${path.join('apps', 'mobile')}`);
    const cap = calls.find((c) => c.args[0] === 'cap');
    expect(cap && line(cap)).toBe('npx cap migrate --noprompt');
    expect(cap?.cwd).toBe(path.join(ws, 'apps/mobile'));
    expect(run).not.toContain('npx nx run-many -t build lint');
  });

  it('19 → 20: runs the inject() migration after the lint packages; a failure only warns', async () => {
    const ws = workspace('19.2.25');
    const { deps, calls, out } = fakeDeps(ws);
    const exec = deps.exec;
    deps.exec = (cmd, args, cwd, env) => {
      if (args[1] === 'g') {
        calls.push({ cmd, args, cwd, env });
        throw new Error('schematic failed');
      }
      exec(cmd, args, cwd, env);
    };
    await runUpgrade(
      makeCtx({ cwd: ws, positionals: ['angular'], flags: { skipCheck: true } }),
      deps,
    );
    const run = calls.map(line);
    const inject = run.indexOf('npx nx g @angular/core:inject --path=./ --interactive=false');
    expect(inject).toBeGreaterThan(run.findIndex((l) => l.startsWith('npm install --save-dev')));
    expect(out.join('\n')).toContain('the inject migration failed (schematic failed)');
    expect(run).toContain('git commit -m chore: upgrade to Angular 20 (pstack upgrade angular)');

    const ws18 = workspace('17.3.12');
    const other = fakeDeps(ws18);
    await runUpgrade(
      makeCtx({ cwd: ws18, positionals: ['angular'], flags: { skipCheck: true } }),
      other.deps,
    );
    expect(other.calls.some((c) => c.args[1] === 'g')).toBe(false);
  });

  it('--dry-run prints the plan and runs nothing', async () => {
    const ws = workspace('17.3.12', { '@ionic/angular': '~7.8.6' });
    const { deps, calls, out } = fakeDeps(ws);
    await runUpgrade(makeCtx({ cwd: ws, positionals: ['angular'], dryRun: true }), deps);
    expect(calls).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('Angular 17 → 18:');
    expect(text).toContain('nx migrate 19.8.14');
    expect(text).toContain('@ionic/angular ~8.7.11');
    expect(text).toContain('Dry run: nothing was changed.');
    expect(readPkg(ws).dependencies['@angular/core']).toBe('~17.3.12');
  });

  it('refuses a dirty tree, a non-git folder and a bad --to; says when there is nothing to do', async () => {
    const ws = workspace('16.2.12');
    const ctx = makeCtx({ cwd: ws, positionals: ['angular'] });
    await expect(
      runUpgrade(ctx, fakeDeps(ws, { gitStatus: () => ' M a.ts\n' }).deps),
    ).rejects.toThrow(/commit or stash/);
    await expect(runUpgrade(ctx, fakeDeps(ws, { gitStatus: () => null }).deps)).rejects.toThrow(
      /git repository/,
    );
    await expect(
      runUpgrade(
        makeCtx({ cwd: ws, positionals: ['angular'], flags: { to: '16' } }),
        fakeDeps(ws).deps,
      ),
    ).rejects.toThrow(/--to must be an Angular major from 17 to 21/);
    await expect(
      runUpgrade(makeCtx({ cwd: ws, positionals: [] }), fakeDeps(ws).deps),
    ).rejects.toThrow(/pstack upgrade angular/);
    const top = workspace('21.2.24');
    const { deps, calls, out } = fakeDeps(top);
    expect(await runUpgrade(makeCtx({ cwd: top, positionals: ['angular'] }), deps)).toBe(0);
    expect(calls).toEqual([]);
    expect(out.join('\n')).toContain('Nothing to do');
  });

  it('--to runs one step at a time: stops without a terminal, continues with --yes or a yes', async () => {
    const ws = workspace('17.3.12');
    const stop = fakeDeps(ws);
    await runUpgrade(
      makeCtx({ cwd: ws, positionals: ['angular'], flags: { to: '19', skipCheck: true } }),
      stop.deps,
    );
    expect(stop.calls.filter((c) => c.args[0] === 'commit')).toHaveLength(1);
    expect(stop.out.join('\n')).toContain('Stopped after Angular 18');

    const ws2 = workspace('17.3.12');
    const all = fakeDeps(ws2);
    await runUpgrade(
      makeCtx({
        cwd: ws2,
        positionals: ['angular'],
        flags: { to: '19', yes: true, skipCheck: true },
      }),
      all.deps,
    );
    expect(all.calls.filter((c) => c.args[0] === 'commit').map(line)).toEqual([
      'git commit -m chore: upgrade to Angular 18 (pstack upgrade angular)',
      'git commit -m chore: upgrade to Angular 19 (pstack upgrade angular)',
    ]);

    const ws3 = workspace('17.3.12');
    const asked: string[] = [];
    const ask = fakeDeps(ws3, {
      interactive: true,
      prompter: () => scriptedPrompter(['n'], asked),
    });
    await runUpgrade(
      makeCtx({ cwd: ws3, positionals: ['angular'], flags: { to: '19', skipCheck: true } }),
      ask.deps,
    );
    expect(asked).toEqual(['Angular 18 is done. Continue to Angular 19? (y/N)']);
    expect(ask.calls.filter((c) => c.args[0] === 'commit')).toHaveLength(1);
  });

  it('--no-commit does one step and leaves it uncommitted', async () => {
    const ws = workspace('18.2.14');
    const { deps, calls, out } = fakeDeps(ws);
    await runUpgrade(
      makeCtx({
        cwd: ws,
        positionals: ['angular'],
        flags: { to: '20', noCommit: true, skipCheck: true },
      }),
      deps,
    );
    expect(calls.some((c) => c.cmd === 'git')).toBe(false);
    expect(out.join('\n')).toContain('--no-commit: only the Angular 19 step runs');
    expect(readPkg(ws).devDependencies['nx']).toBe('20.8.4');
  });
});

describe('repairHttpClientModule (Angular 18 migration leftover)', () => {
  it('drops HttpClientModule from arrays in files that no longer import it', () => {
    const ws = tmpDir('pstack-http-');
    const lib = path.join(ws, 'libs/shared/data-access/src/lib/shared-data-access.module.ts');
    fs.mkdirSync(path.dirname(lib), { recursive: true });
    fs.writeFileSync(
      lib,
      "import { NgModule } from '@angular/core';\n" +
        "import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';\n\n" +
        '@NgModule({ exports: [HttpClientModule], imports: [], providers: [provideHttpClient(withInterceptorsFromDi())] })\n' +
        'export class SharedDataAccessModule {}\n',
    );
    const kept = path.join(ws, 'apps/web/src/app/other.module.ts');
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    const keptText =
      "import { HttpClientModule } from '@angular/common/http';\n" +
      '@NgModule({ imports: [HttpClientModule], exports: [HttpClientModule] })\nexport class O {}\n';
    fs.writeFileSync(kept, keptText);

    expect(repairHttpClientModule(ws)).toEqual([
      path.join('libs', 'shared', 'data-access', 'src', 'lib', 'shared-data-access.module.ts'),
    ]);
    expect(fs.readFileSync(lib, 'utf8')).toContain('@NgModule({ exports: [], imports: [],');
    expect(fs.readFileSync(kept, 'utf8')).toBe(keptText);
  });
});
