import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { COMMANDS } from '../../src/cli/commands';
import { runMigrate } from '../../src/cli/commands/migrate';
import { helpText } from '../../src/cli/help';
import {
  assertLocalSupports,
  delegationArgs,
  MIN_LOCAL_VERSION,
  WORKSPACE_COMMANDS,
} from '../../src/cli/launcher';
import { CliError } from '../../src/cli/types';

import { makeCtx, tmpDir, writeJson } from './helpers';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'migrate');
const ANGULAR = path.join(FIXTURES, 'angular15-app');

function workspace(): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), {
    name: '@acme/source',
    devDependencies: { nx: '17.0.6' },
  });
  writeJson(path.join(ws, 'tsconfig.base.json'), { compilerOptions: { paths: {} } });
  fs.mkdirSync(path.join(ws, 'apps'));
  return ws;
}

describe('pstack migrate', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('requires --source', async () => {
    const err = runMigrate(makeCtx({ cwd: workspace() }));
    await expect(err).rejects.toBeInstanceOf(CliError);
    await expect(err).rejects.toThrow(/--source is required[\s\S]*pstack migrate --source=/);
  });

  it('--detect prints the table without a workspace and writes nothing', async () => {
    const cwd = tmpDir();
    expect(await runMigrate(makeCtx({ cwd, flags: { source: ANGULAR, detect: true } }))).toBe(0);
    const out = log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('angular-cli        1.00');
    expect(out).toContain('pstack migrate would use the angular-cli adapter.');
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('rejects a bad --max-files', async () => {
    await expect(
      runMigrate(makeCtx({ cwd: workspace(), flags: { source: ANGULAR, maxFiles: 'lots' } })),
    ).rejects.toThrow('--max-files must be a positive whole number (got "lots").');
  });

  it('--force-angular=false is false', async () => {
    const ws = workspace();
    writeJson(path.join(ws, 'package.json'), {
      dependencies: { '@angular/core': '~16.2.0' },
      devDependencies: { nx: '17.0.6' },
    });
    await expect(
      runMigrate(
        makeCtx({ cwd: ws, flags: { source: ANGULAR, name: 'portal', forceAngular: 'false' } }),
      ),
    ).rejects.toThrow(/--force-angular/);
    expect(fs.existsSync(path.join(ws, 'apps/portal'))).toBe(false);
  });

  it('--detect=false migrates instead of detecting', async () => {
    const ws = workspace();
    await runMigrate(
      makeCtx({
        cwd: ws,
        dryRun: true,
        flags: { source: ANGULAR, name: 'portal', detect: 'false' },
      }),
    );
    expect(log.mock.calls.map((c) => c[0]).join('\n')).not.toContain('Confidence');
  });

  it('--detect resolves --source against the cwd and rejects a missing directory', async () => {
    await runMigrate(makeCtx({ cwd: FIXTURES, flags: { source: 'flutter-app', detect: true } }));
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain('flutter adapter');
    await expect(
      runMigrate(makeCtx({ cwd: FIXTURES, flags: { source: 'nope', detect: true } })),
    ).rejects.toThrow('--source "nope" is not a directory.');
  });

  it('--detect names unsupported shapes it recognised', async () => {
    const ws = workspace();
    await runMigrate(makeCtx({ cwd: tmpDir(), flags: { source: ws, detect: true } }));
    const out = log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('No adapter reaches 0.80; pick one with --adapter=<id>');
    expect(out).toContain('nx-workspace       0.30');
    expect(out).toContain('no project nx-polystack can migrate yet');
  });

  it('requires a workspace to migrate', async () => {
    await expect(
      runMigrate(makeCtx({ cwd: tmpDir(), flags: { source: ANGULAR } })),
    ).rejects.toThrow(/no nx.json found[\s\S]*pstack migrate/);
  });

  it('writes nothing with --dry-run', async () => {
    const ws = workspace();
    await runMigrate(
      makeCtx({ cwd: ws, dryRun: true, flags: { source: ANGULAR, name: 'portal' } }),
    );
    expect(fs.existsSync(path.join(ws, 'apps/portal'))).toBe(false);
  });

  it('migrates from a subdirectory, with --source relative to it and the flags passed through', async () => {
    const ws = workspace();
    const sub = path.join(ws, 'apps');
    const rel = path.relative(sub, ANGULAR);
    // The install callback would run npm; keep it out of the unit test.
    const deps = await import('../../src/lib/utils/dependencies');
    jest.spyOn(deps, 'addMissingDependencies').mockReturnValue(undefined);
    jest.spyOn(deps, 'ensureReleaseHardeningDependencies').mockReturnValue(undefined);
    const angularDeps = await import('../../src/lib/utils/angular-deps');
    jest.spyOn(angularDeps, 'ensureAngularDependencies').mockReturnValue(undefined);
    writeJson(path.join(ws, 'package.json'), {
      dependencies: { '@angular/core': '~16.2.0' },
      devDependencies: { nx: '17.0.6' },
    });

    await expect(
      runMigrate(makeCtx({ cwd: sub, flags: { source: rel, name: 'portal' } })),
    ).rejects.toThrow(/--force-angular/);

    expect(
      await runMigrate(
        makeCtx({
          cwd: sub,
          flags: { source: rel, name: 'portal', adapter: 'angular-cli', forceAngular: true },
        }),
      ),
    ).toBe(0);
    const pj = JSON.parse(fs.readFileSync(path.join(ws, 'apps/portal/project.json'), 'utf8'));
    expect(pj.targets.build.options.main).toBe('apps/portal/src/main.ts');
    const report = fs.readFileSync(path.join(ws, 'docs/migrations/portal.md'), 'utf8');
    expect(report).toContain(`- Source: \`${ANGULAR}\``);
    expect(report).toContain('(selected with `--adapter`)');
  });

  it('passes --projects, --no-deps and --prefix to the generator', async () => {
    const ws = workspace();
    const deps = await import('../../src/lib/utils/dependencies');
    jest.spyOn(deps, 'addMissingDependencies').mockReturnValue(undefined);
    jest.spyOn(deps, 'ensureReleaseHardeningDependencies').mockReturnValue(undefined);
    const angularDeps = await import('../../src/lib/utils/angular-deps');
    jest.spyOn(angularDeps, 'ensureAngularDependencies').mockReturnValue(undefined);
    const NX = path.join(FIXTURES, 'nx16-workspace');
    expect(
      await runMigrate(
        makeCtx({
          cwd: ws,
          flags: { source: NX, projects: 'admin', noDeps: true, prefix: 'acme' },
        }),
      ),
    ).toBe(0);
    const pj = JSON.parse(fs.readFileSync(path.join(ws, 'apps/admin/project.json'), 'utf8'));
    expect(pj.name).toBe('acme-admin');
    expect(fs.existsSync(path.join(ws, 'libs/shared/util'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'docs/migrations/source.md'))).toBe(true);
  });

  it('refuses --projects and --prefix without a value', async () => {
    const ws = workspace();
    const NX = path.join(FIXTURES, 'nx16-workspace');
    await expect(
      runMigrate(makeCtx({ cwd: ws, flags: { source: NX, projects: true } })),
    ).rejects.toThrow('--projects needs a value: --projects=a,b');
    await expect(
      runMigrate(makeCtx({ cwd: ws, flags: { source: NX, prefix: true } })),
    ).rejects.toThrow('--prefix needs a value: --prefix=<p>');
  });

  it('delegation makes a relative --source absolute when the delegate runs elsewhere', () => {
    const argv = ['migrate', '--source=../legacy', '--name=portal'];
    expect(delegationArgs('migrate', argv, '/ws/apps', '/ws')).toEqual([
      'migrate',
      `--source=${path.resolve('/ws/apps', '../legacy')}`,
      '--name=portal',
    ]);
    expect(delegationArgs('migrate', argv, '/ws', '/ws')).toEqual(argv);
    expect(delegationArgs('migrate', ['migrate', '--source=/abs'], '/ws/a', '/ws')).toEqual([
      'migrate',
      '--source=/abs',
    ]);
    expect(delegationArgs('app', ['app', '--source=x'], '/ws/a', '/ws')).toEqual([
      'app',
      '--source=x',
    ]);
  });

  it('is registered, delegated from the workspace root, needs 0.12.0 locally (0.13.0 for --rollback), and is in the help', () => {
    expect(COMMANDS['migrate']).toBeDefined();
    expect(WORKSPACE_COMMANDS.has('migrate')).toBe(true);
    expect(MIN_LOCAL_VERSION['migrate']).toBe('0.12.0');
    expect(() => assertLocalSupports('migrate', '0.9.1')).toThrow(
      'pstack migrate needs nx-polystack >= 0.12.0 in this workspace (found 0.9.1). ' +
        'Run "pstack update" first.',
    );
    expect(() => assertLocalSupports('migrate', '0.12.0')).not.toThrow();
    const help = helpText('0.0.0');
    expect(help).toContain('OPTIONS — migrate');
    expect(help).toContain('--rollback=<name>');
    expect(help).toContain('--config=<file>');
    expect(() => assertLocalSupports('migrate', '0.12.1', { rollback: 'portal' })).toThrow(
      'pstack migrate --rollback needs nx-polystack >= 0.13.0 in this workspace (found 0.12.1).',
    );
    expect(() => assertLocalSupports('migrate', '0.12.1', { source: 'x' })).not.toThrow();
    expect(() => assertLocalSupports('migrate', '0.13.0', { rollback: 'portal' })).not.toThrow();
    expect(help).toContain('--force-angular');
    expect(help).toContain('--projects=<a,b>');
    expect(help).toContain('--no-deps');
    expect(help).toContain('--prefix=<p>');
    expect(help).toContain('pstack migrate --source=../legacy-portal --detect');
    expect(help).not.toContain('Phase 8');
  });

  describe('--rollback', () => {
    it('needs a value and refuses --source', async () => {
      await expect(
        runMigrate(makeCtx({ cwd: workspace(), flags: { rollback: true } })),
      ).rejects.toThrow('--rollback needs a value: --rollback=<name>');
      await expect(
        runMigrate(makeCtx({ cwd: workspace(), flags: { rollback: 'portal', source: ANGULAR } })),
      ).rejects.toThrow('--rollback and --source cannot be used together');
    });

    it('undoes a migration; --dry-run writes nothing', async () => {
      const ws = workspace();
      const pkgBefore = JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'));
      // Migrate without the install callback (it would run npm).
      const { FsTree, flushChanges } = await import('nx/src/generators/tree');
      const { default: migrateGenerator } = await import('../../src/generators/migrate/generator');
      const tree = new FsTree(ws, false);
      await migrateGenerator(tree, { source: ANGULAR, name: 'portal' });
      flushChanges(ws, tree.listChanges());
      expect(fs.existsSync(path.join(ws, 'docs/migrations/portal.manifest.json'))).toBe(true);

      await runMigrate(makeCtx({ cwd: ws, dryRun: true, flags: { rollback: 'portal' } }));
      expect(fs.existsSync(path.join(ws, 'apps/portal/project.json'))).toBe(true);

      await runMigrate(makeCtx({ cwd: ws, flags: { rollback: 'portal' } }));
      expect(fs.existsSync(path.join(ws, 'apps/portal/project.json'))).toBe(false);
      expect(fs.existsSync(path.join(ws, 'docs/migrations/portal.md'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'))).toEqual(pkgBefore);
    });
  });

  describe('--config', () => {
    it('needs a value and refuses --source', async () => {
      await expect(
        runMigrate(makeCtx({ cwd: workspace(), flags: { config: true } })),
      ).rejects.toThrow('--config needs a value: --config=<file>');
      await expect(
        runMigrate(makeCtx({ cwd: workspace(), flags: { config: 'b.json', source: ANGULAR } })),
      ).rejects.toThrow(
        'migrate: --config takes only --force-angular, --max-files, --min-confidence, --dir, --no-rewrite-imports and --dry-run (got --source).',
      );
      await expect(
        runMigrate(
          makeCtx({ cwd: workspace(), flags: { config: 'b.json', name: true, noDeps: true } }),
        ),
      ).rejects.toThrow('(got --name, --no-deps)');
      await expect(
        runMigrate(makeCtx({ cwd: workspace(), flags: { config: 'b.json', maxFiles: 'abc' } })),
      ).rejects.toThrow('--max-files must be a positive whole number (got "abc").');
    });

    it('resolves the file from the cwd; --dry-run writes nothing', async () => {
      const ws = workspace();
      writeJson(path.join(ws, 'tools/migrations.json'), {
        migrations: [{ source: path.join(FIXTURES, 'flutter-app'), name: 'notes' }],
      });
      await runMigrate(
        makeCtx({
          cwd: path.join(ws, 'tools'),
          dryRun: true,
          flags: { config: 'migrations.json' },
        }),
      );
      expect(fs.existsSync(path.join(ws, 'apps/notes'))).toBe(false);
      await runMigrate(
        makeCtx({ cwd: path.join(ws, 'tools'), flags: { config: 'migrations.json' } }),
      );
      expect(fs.existsSync(path.join(ws, 'apps/notes/pubspec.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(ws, 'docs/migrations/notes.manifest.json'))).toBe(true);
    });

    it('keeps a relative --config path when delegating from another directory', () => {
      expect(delegationArgs('migrate', ['--config=b.json'], '/a', '/b')).toEqual([
        '--config=/a/b.json',
      ]);
    });

    it('needs 0.14.0 locally only with --config', () => {
      expect(() => assertLocalSupports('migrate', '0.13.0', { config: 'b.json' })).toThrow(
        'pstack migrate --config needs nx-polystack >= 0.14.0 in this workspace (found 0.13.0).',
      );
      expect(() => assertLocalSupports('migrate', '0.13.0', { source: 'x' })).not.toThrow();
    });
  });

  describe('--min-confidence', () => {
    it('is validated, used by --detect, and needs 0.15.0 locally', async () => {
      await expect(
        runMigrate(
          makeCtx({ cwd: tmpDir(), flags: { source: ANGULAR, detect: true, minConfidence: '2' } }),
        ),
      ).rejects.toThrow('from 0.50 to 1.00 (got 2)');
      await runMigrate(
        makeCtx({ cwd: tmpDir(), flags: { source: ANGULAR, detect: true, minConfidence: '1' } }),
      );
      expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain(
        'pstack migrate would use the angular-cli adapter.',
      );
      expect(() => assertLocalSupports('migrate', '0.14.0', { minConfidence: '0.6' })).toThrow(
        'pstack migrate --min-confidence needs nx-polystack >= 0.15.0',
      );
      expect(() => assertLocalSupports('migrate', '0.15.0', { dir: 'legacy' })).toThrow(
        'pstack migrate --dir needs nx-polystack >= 0.16.0',
      );
    });
  });

  describe('--no-rewrite-imports', () => {
    it('keeps the copied imports as they were, refuses both spellings, needs 0.21.0 locally', async () => {
      // The install callback would run npm; keep it out of the unit test.
      const deps = await import('../../src/lib/utils/dependencies');
      jest.spyOn(deps, 'addMissingDependencies').mockReturnValue(undefined);
      jest.spyOn(deps, 'ensureReleaseHardeningDependencies').mockReturnValue(undefined);
      const angularDeps = await import('../../src/lib/utils/angular-deps');
      jest.spyOn(angularDeps, 'ensureAngularDependencies').mockReturnValue(undefined);
      const src = tmpDir();
      fs.cpSync(ANGULAR, src, { recursive: true });
      fs.writeFileSync(
        path.join(src, 'src/app/feature.ts'),
        "import { environment } from 'src/environments/environment';\n",
      );
      const on = workspace();
      await runMigrate(makeCtx({ cwd: on, flags: { source: src, name: 'portal' } }));
      expect(fs.readFileSync(path.join(on, 'apps/portal/src/app/feature.ts'), 'utf8')).toContain(
        "'../environments/environment'",
      );
      const off = workspace();
      await runMigrate(
        makeCtx({ cwd: off, flags: { source: src, name: 'portal', noRewriteImports: true } }),
      );
      expect(fs.readFileSync(path.join(off, 'apps/portal/src/app/feature.ts'), 'utf8')).toContain(
        "'src/environments/environment'",
      );
      await expect(
        runMigrate(
          makeCtx({
            cwd: workspace(),
            flags: { source: src, noRewriteImports: true, rewriteImports: 'true' },
          }),
        ),
      ).rejects.toThrow('Pass --rewrite-imports or --no-rewrite-imports, not both.');
      expect(() => assertLocalSupports('migrate', '0.20.0', { noRewriteImports: true })).toThrow(
        'pstack migrate --no-rewrite-imports needs nx-polystack >= 0.21.0',
      );
      expect(helpText('0.0.0')).toContain('--no-rewrite-imports');
    });
  });

  describe('--new-adapter and external adapters', () => {
    it('writes a starter adapter; --detect inside the workspace lists listed adapters', async () => {
      const ws = workspace();
      await expect(runMigrate(makeCtx({ cwd: ws, flags: { newAdapter: true } }))).rejects.toThrow(
        '--new-adapter needs a value',
      );
      expect(await runMigrate(makeCtx({ cwd: ws, flags: { newAdapter: 'static-site' } }))).toBe(0);
      expect(fs.existsSync(path.join(ws, 'tools/migrate/static-site.adapter.ts'))).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(path.join(ws, 'nx.json'), 'utf8')).pstack.migrateAdapters,
      ).toEqual(['./tools/migrate/static-site.adapter.ts']);

      const adapter = path.join(ws, 'tools/migrate/plain.js');
      fs.writeFileSync(
        adapter,
        "module.exports = { apiVersion: 1, id: 'plain', label: 'plain', " +
          "detect: () => ({ confidence: 0.42, reasons: ['always'] }), defaultName: () => 'p', " +
          'migrate: () => { throw new Error("unused"); } };\n',
      );
      writeJson(path.join(ws, 'nx.json'), {
        pstack: { migrateAdapters: ['./tools/migrate/plain.js'] },
      });
      await runMigrate(makeCtx({ cwd: ws, flags: { source: ANGULAR, detect: true } }));
      expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain('plain              0.42');
      writeJson(path.join(ws, 'nx.json'), { pstack: { migrateAdapters: ['./nope.js'] } });
      await expect(
        runMigrate(makeCtx({ cwd: ws, flags: { source: ANGULAR, detect: true } })),
      ).rejects.toThrow('nx.json pstack.migrateAdapters entry "./nope.js": no such file');
      expect(() => assertLocalSupports('migrate', '0.21.0', { newAdapter: 'x' })).toThrow(
        'pstack migrate --new-adapter needs nx-polystack >= 0.22.0',
      );
      expect(helpText('0.0.0')).toContain('--new-adapter=<id>');
    });
  });
});
