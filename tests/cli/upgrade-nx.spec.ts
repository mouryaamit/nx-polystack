import * as fs from 'fs';
import * as path from 'path';

import { runUpgrade, UpgradeDeps } from '../../src/cli/commands/upgrade';
import {
  filterMigrations,
  keepAngularPackages,
  loadSemver,
} from '../../src/lib/upgrade/nx-migrate';
import { scriptedPrompter } from '../../src/cli/prompt';

import { makeCtx, tmpDir, writeJson } from './helpers';

type Pkg = Record<string, Record<string, string>>;

const PLUGIN_SPEC = 'github:example-org/private-plugin#v1.7.0';

/** An Nx 15 workspace laid out by hand: compact JSON, a Markdown doc, a binary file. */
function workspace(): string {
  const ws = tmpDir('pstack-upgrade-nx-');
  writeJson(path.join(ws, 'nx.json'), { npmScope: 'acme' });
  fs.writeFileSync(
    path.join(ws, 'package.json'),
    [
      '{',
      '  "name": "acme",',
      '  "scripts": { "build": "nx build" },',
      '  "dependencies": { "@angular/core": "^15.2.10" },',
      '  "devDependencies": {',
      `    "@mouryaamit/nx-polystack": "${PLUGIN_SPEC}",`,
      '    "@nrwl/angular": "15.9.7",',
      '    "nx": "15.9.7",',
      '    "typescript": "~4.8.4"',
      '  },',
      '  "overrides": { "a": { "x": "1" } }',
      '}',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(ws, 'apps/web'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'apps/web/project.json'),
    '{ "name": "web", "targets": { "lint": { "executor": "@nrwl/linter:eslint" } } }\n',
  );
  fs.writeFileSync(path.join(ws, 'README.md'), 'Run nx g @nrwl/angular:lib\n');
  fs.writeFileSync(path.join(ws, 'logo.lnk'), Buffer.from([0, 1, 2, 64, 110, 114, 119, 108]));
  writeJson(path.join(ws, 'node_modules/nx/package.json'), { name: 'nx', version: '15.9.7' });
  writeJson(path.join(ws, 'node_modules/@angular/core/package.json'), { version: '15.2.10' });
  return ws;
}

const readPkg = (ws: string): Pkg =>
  JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'));

interface Call {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Plays nx migrate (non-interactive: Angular updated too, a "v" version, a migrations.json with
 * Angular ones), npm install, the migrations (rename, JSON re-layout, Markdown and binary text
 * replace) and git.
 */
function fakeDeps(ws: string, over: Partial<UpgradeDeps> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const changed = new Set<string>();
  const deps: UpgradeDeps = {
    exec(cmd, args, _cwd, env) {
      calls.push({ cmd, args, env });
      const pkg = readPkg(ws);
      if (cmd === 'npx' && args[1] === 'migrate' && args[2] !== '--run-migrations') {
        const to = args[2];
        const dev = pkg['devDependencies'];
        if (dev['@nrwl/angular']) dev['@nrwl/angular'] = to;
        if (dev['@nx/angular']) dev['@nx/angular'] = to;
        if (dev['@nx/devkit']) dev['@nx/devkit'] = to;
        dev['nx'] = to.startsWith('17') ? `v${to}` : to;
        dev['typescript'] = '~5.1.3';
        dev['@angular-devkit/core'] = '~16.2.0';
        pkg['dependencies']['@angular/core'] = '~16.2.0';
        fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
        writeJson(path.join(ws, 'migrations.json'), {
          migrations: [
            { package: 'nx', name: 'rename', version: '16.0.0' },
            { package: '@angular/core', name: 'ng16', version: '16.0.0' },
            {
              package: '@nx/angular',
              name: 'needs-16',
              version: '16.1.0',
              requires: { '@angular/core': '>=16.0.0' },
            },
            {
              package: '@nx/angular',
              name: 'any-15',
              version: '16.1.0',
              requires: { '@angular/core': '>=15.0.0' },
            },
          ],
        });
        changed.add('package.json');
      } else if (cmd === 'npx' && args[2] === '--run-migrations') {
        const m = JSON.parse(fs.readFileSync(path.join(ws, 'migrations.json'), 'utf8'));
        out.push(`ran ${m.migrations.map((x: { name: string }) => x.name).join(',')}`);
        const pj = path.join(ws, 'apps/web/project.json');
        const v = JSON.parse(fs.readFileSync(pj, 'utf8'));
        v.targets.lint.executor = '@nx/eslint:lint';
        fs.writeFileSync(pj, JSON.stringify(v, null, 2) + '\n');
        fs.writeFileSync(path.join(ws, 'README.md'), 'Run nx g @nx/angular:lib\n');
        fs.writeFileSync(path.join(ws, 'logo.lnk'), Buffer.from([0, 1, 2, 64, 110, 120]));
        for (const f of ['apps/web/project.json', 'README.md', 'logo.lnk']) changed.add(f);
      } else if (cmd === 'npm' && args[0] === 'install') {
        writeJson(path.join(ws, 'node_modules/nx/package.json'), {
          name: 'nx',
          version: String(readPkg(ws)['devDependencies']['nx']).replace(/^v/, ''),
        });
      } else if (cmd === 'git' && args[0] === 'checkout') {
        for (const f of args.slice(2)) {
          if (f === 'README.md') fs.writeFileSync(path.join(ws, f), 'Run nx g @nrwl/angular:lib\n');
          changed.delete(f);
        }
      }
    },
    capture: (cmd, args) =>
      cmd === 'git' && args[0] === 'diff' ? [...changed].join('\n') + '\n' : '',
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

describe('pstack upgrade nx', () => {
  it('moves Nx 15 to 17 one major per commit, Angular unchanged, plugin out and back', async () => {
    const ws = workspace();
    const { deps, calls, out } = fakeDeps(ws);
    expect(await runUpgrade(makeCtx({ cwd: ws, positionals: ['nx'] }), deps)).toBe(0);

    const migrates = calls.filter(
      (c) => c.args[1] === 'migrate' && c.args[2] !== '--run-migrations',
    );
    expect(migrates.map(line)).toEqual([
      'npx nx migrate 16.9.1 --interactive=false',
      'npx nx migrate 17.0.6 --interactive=false',
    ]);
    expect(migrates[0].env).toEqual({ NX_SKIP_PROVENANCE_CHECK: 'true' });
    expect(calls.map(line).filter((l) => l.startsWith('git commit'))).toEqual([
      'git commit -m chore: upgrade to Nx 16.9.1 (pstack upgrade nx)',
      'git commit -m chore: upgrade to Nx 17.0.6 (pstack upgrade nx)',
    ]);
    // Angular-only migrations left out; the others ran.
    expect(out).toContain('ran rename,any-15');

    const text = fs.readFileSync(path.join(ws, 'package.json'), 'utf8');
    const pkg = JSON.parse(text);
    expect(pkg.dependencies['@angular/core']).toBe('^15.2.10');
    expect(pkg.devDependencies).toEqual({
      '@mouryaamit/nx-polystack': PLUGIN_SPEC,
      '@nrwl/angular': '17.0.6',
      '@nx/devkit': '17.0.6',
      nx: '17.0.6',
      typescript: '~4.8.4',
    });
    // Layout kept: one-line objects stay one line.
    expect(text).toContain('  "overrides": { "a": { "x": "1" } }');
    expect(text).toContain('  "scripts": { "build": "nx build" },');
    expect(fs.readFileSync(path.join(ws, 'apps/web/project.json'), 'utf8')).toBe(
      '{ "name": "web", "targets": { "lint": { "executor": "@nx/eslint:lint" } } }\n',
    );
    // Markdown and binary files put back.
    const checkout = calls.map(line).find((l) => l.startsWith('git checkout'));
    expect(checkout).toBe('git checkout -- README.md logo.lnk');
    expect(fs.readFileSync(path.join(ws, 'README.md'), 'utf8')).toBe(
      'Run nx g @nrwl/angular:lib\n',
    );
    expect(calls.map(line)).toContain('npx nx run-many -t build');
  });

  it('retries nx migrate with the workspace Nx when the newest CLI fails', async () => {
    const ws = workspace();
    const base = fakeDeps(ws);
    let failed = false;
    const { deps, calls } = fakeDeps(ws, {
      exec(cmd, args, cwd, env) {
        if (args[1] === 'migrate' && env?.['NX_SKIP_PROVENANCE_CHECK'] && !failed) {
          failed = true;
          calls.push({ cmd, args, env });
          throw new Error('Version ref does not match');
        }
        base.deps.exec(cmd, args, cwd, env);
        calls.push({ cmd, args, env });
      },
    });
    await runUpgrade(makeCtx({ cwd: ws, positionals: ['nx'], flags: { to: '16' } }), deps);
    expect(calls.filter((c) => c.args[1] === 'migrate').map((c) => c.env)).toEqual([
      { NX_SKIP_PROVENANCE_CHECK: 'true' },
      { NX_MIGRATE_USE_LOCAL: 'true' },
      undefined,
    ]);
  });

  it('--to=16 keeps the plugin out and says how to put it back', async () => {
    const ws = workspace();
    const { deps, out } = fakeDeps(ws);
    await runUpgrade(makeCtx({ cwd: ws, positionals: ['nx'], flags: { to: '16' } }), deps);
    expect(readPkg(ws)['devDependencies']['@mouryaamit/nx-polystack']).toBeUndefined();
    expect(out.join('\n')).toContain(
      `add it back with: npm i -D @mouryaamit/nx-polystack@${PLUGIN_SPEC} @nx/devkit@17.0.6`,
    );
  });

  it('refuses --no-commit across two steps while the plugin is out, and dirty trees', async () => {
    const ws = workspace();
    await expect(
      runUpgrade(
        makeCtx({ cwd: ws, positionals: ['nx'], flags: { noCommit: true } }),
        fakeDeps(ws).deps,
      ),
    ).rejects.toThrow(/--no-commit runs one step/);
    await expect(
      runUpgrade(
        makeCtx({ cwd: ws, positionals: ['nx'] }),
        fakeDeps(ws, { gitStatus: () => ' M package.json' }).deps,
      ),
    ).rejects.toThrow(/commit or stash/);
  });

  it('--dry-run lists the steps and changes nothing; Nx 17 has nothing to do', async () => {
    const ws = workspace();
    const before = fs.readFileSync(path.join(ws, 'package.json'), 'utf8');
    const { deps, calls, out } = fakeDeps(ws);
    await runUpgrade(makeCtx({ cwd: ws, positionals: ['nx'], dryRun: true }), deps);
    expect(calls).toEqual([]);
    expect(fs.readFileSync(path.join(ws, 'package.json'), 'utf8')).toBe(before);
    expect(out.join('\n')).toContain('Nx 15 → 16:');
    expect(out.join('\n')).toContain('Nx 16 → 17:');

    writeJson(path.join(ws, 'node_modules/nx/package.json'), { name: 'nx', version: '17.0.6' });
    const done = fakeDeps(ws);
    await runUpgrade(makeCtx({ cwd: ws, positionals: ['nx'] }), done.deps);
    expect(done.calls).toEqual([]);
    expect(done.out.join('\n')).toContain('nx-polystack loads on it');
  });
});

describe('nx migrate helpers', () => {
  it('keepAngularPackages puts Angular back, drops added ones and fixes "v" specs', () => {
    const before = { dependencies: { '@angular/core': '^15.2.10', rxjs: '~7.8.0' } };
    const after: Record<string, unknown> = {
      dependencies: { '@angular/core': '~16.2.0', rxjs: '~7.8.0', '@angular/ssr': '16.0.0' },
      devDependencies: { nx: 'v17.0.6' },
    };
    expect(keepAngularPackages(before, after)).toEqual(['@angular/core', '@angular/ssr']);
    expect(after).toEqual({
      dependencies: { '@angular/core': '^15.2.10', rxjs: '~7.8.0' },
      devDependencies: { nx: '17.0.6' },
    });
  });

  it('filterMigrations keeps a migration whose Angular requirement the kept version meets', () => {
    const file = path.join(tmpDir(), 'migrations.json');
    writeJson(file, {
      migrations: [
        { package: '@nx/angular', name: 'a', requires: { '@angular/core': '>=15.0.0 <16.0.0' } },
        { package: '@nx/angular', name: 'b', requires: { '@angular/core': '>=16.0.0' } },
      ],
    });
    expect(filterMigrations(file, () => '15.2.10', loadSemver(process.cwd()))).toEqual([
      '@nx/angular:b',
    ]);
  });
});
