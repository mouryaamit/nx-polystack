import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { COMMANDS } from '../../src/cli/commands';
import { runEncryption } from '../../src/cli/commands/encryption';
import { helpText } from '../../src/cli/help';
import { MIN_LOCAL_VERSION, WORKSPACE_COMMANDS } from '../../src/cli/launcher';

import { makeCtx, tmpDir, writeJson } from './helpers';

function workspace(nx: Record<string, unknown> = {}): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), nx);
  writeJson(path.join(ws, 'package.json'), { name: '@acme/source' });
  return ws;
}
const nxOf = (ws: string) => JSON.parse(fs.readFileSync(path.join(ws, 'nx.json'), 'utf8'));
const out = () => (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');

describe('pstack encryption', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is a workspace command delegated to plugins from 0.25.0', () => {
    expect(COMMANDS['encryption']).toBeDefined();
    expect(WORKSPACE_COMMANDS.has('encryption')).toBe(true);
    expect(MIN_LOCAL_VERSION['encryption']).toBe('0.25.0');
    expect(helpText('0.25.0')).toContain('pstack.envEncryption');
  });

  it('shows the settings without changing anything', async () => {
    const ws = workspace({ pstack: { envEncryption: { keys: { default: ['password'] } } } });
    const before = fs.readFileSync(path.join(ws, 'nx.json'), 'utf8');
    expect(await runEncryption(makeCtx({ cwd: ws }))).toBe(0);
    expect(out()).toContain('mode        listed');
    expect(out()).toContain('keys        default: password');
    expect(fs.readFileSync(path.join(ws, 'nx.json'), 'utf8')).toBe(before);
  });

  it('shows the aes-gcm value format instead of the cryptojs format setting', async () => {
    const ws = workspace({ pstack: { envEncryption: { cipher: 'aes-gcm', format: 'enc' } } });
    expect(await runEncryption(makeCtx({ cwd: ws }))).toBe(0);
    expect(out()).toContain('  cipher      aes-gcm (values written as ENC2(…))');
    expect(out()).not.toContain('format enc');
  });

  it('changes mode, keys, public keys, meta name and stamp', async () => {
    const ws = workspace();
    await runEncryption(
      makeCtx({
        cwd: ws,
        flags: {
          mode: 'all',
          addPublic: 'apiBaseUrl, envName',
          metaName: 'x-app',
          timezone: 'Asia/Kolkata',
          stampFormat: 'DD MMM YYYY HH:mm z',
        },
      }),
    );
    await runEncryption(makeCtx({ cwd: ws, flags: { addKey: 'password,uname,key,iv' } }));
    await runEncryption(makeCtx({ cwd: ws, flags: { addKey: 'token', project: 'web' } }));
    await runEncryption(makeCtx({ cwd: ws, flags: { removeKey: 'iv' } }));
    const cfg = nxOf(ws).pstack.envEncryption;
    expect(cfg.mode).toBe('all');
    expect(cfg.metaName).toBe('x-app');
    expect(cfg.publicKeys).toEqual(
      expect.arrayContaining(['production', 'envName', 'appName', 'timeStamp', 'apiBaseUrl']),
    );
    expect(cfg.keys).toEqual({
      default: ['password', 'uname', 'key'],
      web: ['password', 'uname', 'key', 'iv', 'token'],
    });
    expect(out()).toContain('must use the new name too');
    expect(cfg.stamp).toMatchObject({ timezone: 'Asia/Kolkata', format: 'DD MMM YYYY HH:mm z' });
  });

  it('sets the format and profile files', async () => {
    const ws = workspace();
    await runEncryption(
      makeCtx({ cwd: ws, flags: { format: 'enc', profileFiles: 'app.profile.ts' } }),
    );
    expect(nxOf(ws).pstack.envEncryption).toMatchObject({
      format: 'enc',
      profileFiles: ['app.profile.ts'],
    });
    expect(out()).toContain('profiles    app.profile.ts');
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { profileFiles: '../x.ts' } })),
    ).rejects.toThrow(/inside the env folder/);
  });

  it('refuses invalid values and empty flags without writing', async () => {
    const ws = workspace();
    await expect(runEncryption(makeCtx({ cwd: ws, flags: { mode: 'some' } }))).rejects.toThrow(
      /listed or all/,
    );
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { timezone: 'Mars/Base' } })),
    ).rejects.toThrow(/not a known time zone/);
    await expect(runEncryption(makeCtx({ cwd: ws, flags: { addKey: true } }))).rejects.toThrow(
      /--add-key needs a value/,
    );
    expect(nxOf(ws).pstack).toBeUndefined();
  });

  it('sets cipher and key sources, rotates the salt', async () => {
    const ws = workspace();
    await runEncryption(makeCtx({ cwd: ws, flags: { keySources: 'commit,salt' } }));
    expect(nxOf(ws).pstack.envEncryption.keySources).toEqual(['commit', 'salt']);
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { keySources: 'vault' } })),
    ).rejects.toThrow(/vault/);
    await runEncryption(makeCtx({ cwd: ws, flags: { rotateSalt: true } }));
    const salt = fs.readFileSync(path.join(ws, 'tools/config/env-salt'), 'utf8');
    await runEncryption(makeCtx({ cwd: ws, flags: { rotateSalt: true } }));
    expect(fs.readFileSync(path.join(ws, 'tools/config/env-salt'), 'utf8')).not.toBe(salt);
    expect(out()).toContain('env-salt rotated');
  });

  it('sets key split and domains on an app release target', async () => {
    const ws = workspace({});
    writeJson(path.join(ws, 'apps/portal/project.json'), {
      name: 'portal',
      root: 'apps/portal',
      targets: {
        release: {
          executor: '@mouryaamit/nx-polystack:build',
          options: { type: 'angular', outputPath: 'dist/apps/portal', envProject: 'portal' },
          configurations: { uat: { env: 'UAT' }, prod: { env: 'PROD' } },
        },
      },
    });
    await runEncryption(
      makeCtx({
        cwd: ws,
        flags: {
          app: 'portal',
          keySplit: 'meta-bundle-asset',
          domains: 'uat=UAT.example.com,b.in',
          includeWww: 'false',
          onMismatch: 'warn',
        },
      }),
    );
    const pj = JSON.parse(fs.readFileSync(path.join(ws, 'apps/portal/project.json'), 'utf8'));
    expect(pj.targets.release.options).toMatchObject({
      keySplit: 'meta-bundle-asset',
      includeWww: false,
      onMismatch: 'warn',
    });
    expect(pj.targets.release.configurations.uat.domains).toEqual(['uat.example.com', 'b.in']);
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { app: 'portal', domains: 'qa=a.com' } })),
    ).rejects.toThrow(/qa/);
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { app: 'portal', domains: 'uat=bad host' } })),
    ).rejects.toThrow(/bad host/);
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { keySplit: 'meta-bundle' } })),
    ).rejects.toThrow(/--app/);
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { app: 'portal', keySplit: 'meta' } })),
    ).rejects.toThrow(/--key-split/);
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { app: 'nope', onMismatch: 'warn' } })),
    ).rejects.toThrow(/nope/);
    await runEncryption(
      makeCtx({ cwd: ws, flags: { app: 'portal', domains: 'uat=a.com, b.in ; prod=*.A.com;' } }),
    );
    const both = JSON.parse(fs.readFileSync(path.join(ws, 'apps/portal/project.json'), 'utf8'));
    expect(both.targets.release.configurations.uat.domains).toEqual(['a.com', 'b.in']);
    expect(both.targets.release.configurations.prod.domains).toEqual(['*.a.com']);
    // One bad configuration refuses the whole flag.
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { app: 'portal', domains: 'uat=c.com;qa=a.com' } })),
    ).rejects.toThrow(/qa/);
    await expect(
      runEncryption(makeCtx({ cwd: ws, flags: { app: 'portal', domains: 'uat=c.com;prod' } })),
    ).rejects.toThrow(/--domains must be/);
    await runEncryption(makeCtx({ cwd: ws, flags: { app: 'portal', domains: 'uat=' } }));
    const after = JSON.parse(fs.readFileSync(path.join(ws, 'apps/portal/project.json'), 'utf8'));
    expect(after.targets.release.configurations.uat).toEqual({ env: 'UAT' });
    expect(after.targets.release.configurations.prod.domains).toEqual(['*.a.com']);
  });

  it('notes that app options need aes-gcm when the workspace cipher is cryptojs', async () => {
    const ws = workspace({});
    writeJson(path.join(ws, 'apps/portal/project.json'), {
      name: 'portal',
      root: 'apps/portal',
      targets: {
        release: {
          executor: '@mouryaamit/nx-polystack:build',
          options: { type: 'angular', outputPath: 'dist/apps/portal', envProject: 'portal' },
          configurations: { uat: { env: 'UAT' } },
        },
      },
    });
    const note =
      'These app options take effect with cipher aes-gcm (pstack encryption --cipher=aes-gcm).';
    await runEncryption(makeCtx({ cwd: ws, flags: { app: 'portal', domains: 'uat=a.com' } }));
    expect(out()).toContain(note);
    (console.log as jest.Mock).mockClear();
    writeJson(path.join(ws, 'nx.json'), { pstack: { envEncryption: { cipher: 'aes-gcm' } } });
    await runEncryption(makeCtx({ cwd: ws, flags: { app: 'portal', onMismatch: 'warn' } }));
    expect(out()).not.toContain(note);
  });

  it('documents the aes-gcm flags in help', () => {
    for (const f of [
      '--cipher=',
      '--key-sources=',
      '--rotate-salt',
      '--app=',
      '--key-split=',
      '--domains=',
      'uat=a.com,b.in;prod=a.com',
      '--include-www=',
      '--on-mismatch=',
    ]) {
      expect(helpText('0.28.0')).toContain(f);
    }
    // env and salt values ship in the bundle like the commit; only custom stays out.
    expect(helpText('0.28.0')).toMatch(/dedicated random value/);
  });

  it('switching to aes-gcm rewrites main.ts of release apps', async () => {
    const ws = workspace({});
    writeJson(path.join(ws, 'apps/portal/project.json'), {
      name: 'portal',
      root: 'apps/portal',
      sourceRoot: 'apps/portal/src',
      targets: {
        build: {
          executor: '@angular-devkit/build-angular:browser',
          options: { main: 'apps/portal/src/main.ts' },
        },
        release: {
          executor: '@mouryaamit/nx-polystack:build',
          options: { type: 'angular', outputPath: 'dist/apps/portal', envProject: 'portal' },
        },
      },
    });
    const main = path.join(ws, 'apps/portal/src/main.ts');
    fs.mkdirSync(path.dirname(main), { recursive: true });
    fs.writeFileSync(
      main,
      "import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';\n" +
        "import { AppModule } from './app/app.module';\n" +
        "import { environment } from '../../../environments/portal/environment';\n\n" +
        'platformBrowserDynamic()\n  .bootstrapModule(AppModule)\n  .catch((err) => console.error(err));\n',
    );
    await runEncryption(makeCtx({ cwd: ws, flags: { cipher: 'aes-gcm' } }));
    expect(nxOf(ws).pstack.envEncryption.cipher).toBe('aes-gcm');
    expect(fs.readFileSync(main, 'utf8')).toContain('envReady(environment, { inPlace: true })');
    expect(out()).toContain('apps/portal/src/main.ts now awaits envReady');
    expect(out()).not.toContain('getKey');
    await runEncryption(makeCtx({ cwd: ws, flags: { keySources: 'commit,custom' } }));
    expect(out()).toMatch(/custom.*getKey/s);
    (console.log as jest.Mock).mockClear();
    await runEncryption(makeCtx({ cwd: ws, flags: { cipher: 'cryptojs' } }));
    await runEncryption(makeCtx({ cwd: ws, flags: { cipher: 'aes-gcm' } }));
    expect(out()).toMatch(/custom.*getKey/s);
    expect(out()).not.toContain('now awaits');
  });
});
