import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { COMMANDS } from '../../src/cli/commands';
import { inlinesCriticalCss, runCsp } from '../../src/cli/commands/csp';
import { helpText } from '../../src/cli/help';
import { MIN_LOCAL_VERSION, WORKSPACE_COMMANDS } from '../../src/cli/launcher';
import { GENERATED_MARKER } from '../../src/lib/csp/render';

import { makeCtx, tmpDir, writeJson } from './helpers';

const POLY = '@mouryaamit/nx-polystack:build';

function workspace(build: Record<string, unknown> = {}): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), { name: '@acme/source' });
  writeJson(path.join(ws, 'apps', 'portal', 'project.json'), {
    name: 'portal',
    targets: {
      build: {
        executor: '@angular-devkit/build-angular:browser',
        configurations: {
          production: { optimization: { styles: { inlineCritical: false } } },
          development: { optimization: false },
          ...build,
        },
      },
      release: { executor: POLY, configurations: { uat: { env: 'UAT' } } },
    },
  });
  writeJson(path.join(ws, 'apps', 'portal', 'csp-allowlist.json'), {
    'connect-src': ['https://api.example.com'],
  });
  writeJson(path.join(ws, 'apps', 'mobile', 'project.json'), { name: 'mobile', targets: {} });
  return ws;
}
const read = (ws: string, rel: string) =>
  fs.readFileSync(path.join(ws, 'apps/portal', rel), 'utf8');
const out = () => (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
const run = (ws: string, flags: Record<string, string | boolean>) =>
  runCsp(makeCtx({ cwd: ws, flags: { app: 'portal', ...flags } }));

describe('pstack csp', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is a workspace command delegated to plugins from 0.33.0', () => {
    expect(COMMANDS['csp']).toBeDefined();
    expect(WORKSPACE_COMMANDS.has('csp')).toBe(true);
    expect(MIN_LOCAL_VERSION['csp']).toBe('0.33.0');
    expect(helpText('0.33.0')).toContain('pstack csp --app=portal --add=connect-src:');
  });

  it('writes missing files, then reports them in sync', async () => {
    const ws = workspace();
    await run(ws, {});
    expect(read(ws, 'src/.htaccess').startsWith(GENERATED_MARKER)).toBe(true);
    expect(read(ws, 'server/nginx.conf')).toContain('https://api.example.com');
    expect(out()).toContain('apps/portal/src/.htaccess: written');
    expect(out()).toMatch(/policy\s+default-src 'self'; script-src 'self' 'nonce-<nonce>'/);
    (console.log as jest.Mock).mockClear();
    await run(ws, {});
    expect(out()).toContain('apps/portal/src/.htaccess: in sync');
    expect(out()).toContain('apps/portal/server/nginx.conf: in sync');
  });

  it('adds and removes sources, then re-renders generated files', async () => {
    const ws = workspace();
    await run(ws, {});
    await run(ws, {
      add: 'script-src:https://www.googletagmanager.com, img-src:https://cdn.example.com',
      remove: 'connect-src:https://api.example.com',
    });
    expect(JSON.parse(read(ws, 'csp-allowlist.json'))).toEqual({
      'script-src': ['https://www.googletagmanager.com'],
      'img-src': ['https://cdn.example.com'],
    });
    expect(read(ws, 'src/.htaccess')).toContain(
      "'nonce-%{CSP_NONCE}e' https://www.googletagmanager.com",
    );
    expect(read(ws, 'src/.htaccess')).not.toContain('https://api.example.com');
    expect(out()).toContain('apps/portal/src/.htaccess: updated');
    await run(ws, { remove: 'connect-src:https://nope.example.com' });
    expect(out()).toContain('connect-src has no "https://nope.example.com"; nothing removed.');
  });

  it('dry run says what would be written; CRLF files are still in sync', async () => {
    const ws = workspace();
    await runCsp(makeCtx({ cwd: ws, flags: { app: 'portal' }, dryRun: true }));
    expect(out()).toContain('apps/portal/src/.htaccess: would be written');
    expect(fs.existsSync(path.join(ws, 'apps/portal/src/.htaccess'))).toBe(false);
    await run(ws, {});
    const file = path.join(ws, 'apps/portal/src/.htaccess');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    (console.log as jest.Mock).mockClear();
    await run(ws, {});
    expect(out()).toContain('apps/portal/src/.htaccess: in sync');
  });

  it('keeps hand-written files unless --force', async () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, 'apps/portal/src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'apps/portal/src/.htaccess'), 'FallbackResource /index.html\n');
    await run(ws, {});
    expect(read(ws, 'src/.htaccess')).toBe('FallbackResource /index.html\n');
    expect(out()).toContain('apps/portal/src/.htaccess: hand-written, kept (--force replaces it)');
    await run(ws, { add: 'img-src:https://cdn.example.com' });
    expect(out()).toContain(
      'hand-written, kept (--force replaces it) — it does not have this change',
    );
    await run(ws, { force: true });
    expect(read(ws, 'src/.htaccess').startsWith(GENERATED_MARKER)).toBe(true);
    expect(out()).toContain('apps/portal/src/.htaccess: replaced');
  });

  it('warns when an optimised build inlines critical CSS', async () => {
    const ws = workspace({ uat: { optimization: true } });
    await run(ws, {});
    expect(out()).toContain('Warning: the uat build(s) inline critical CSS');
    expect(
      inlinesCriticalCss({
        targets: {
          build: {
            executor: '@nx/angular:webpack-browser',
            options: {},
            configurations: {
              a: {},
              b: { optimization: { styles: false } },
              c: { optimization: { styles: { minify: true } } },
            },
          },
        },
      }),
    ).toEqual(['a', 'c']);
  });

  it('rejects bad input and leaves files alone', async () => {
    const ws = workspace();
    await expect(run(ws, { add: 'script-src:https://ok.com,script-src:*' })).rejects.toThrow(
      `"script-src": "*" — "*" allows any host`,
    );
    expect(fs.existsSync(path.join(ws, 'apps/portal/src/.htaccess'))).toBe(false);
    expect(JSON.parse(read(ws, 'csp-allowlist.json'))).toEqual({
      'connect-src': ['https://api.example.com'],
    });
    await expect(run(ws, { add: 'default-src:https://a.com' })).rejects.toThrow(
      '--add: "default-src:https://a.com" must be <directive>:<source>',
    );
    await expect(run(ws, { add: true })).rejects.toThrow('--add needs a value.');
    await expect(runCsp(makeCtx({ cwd: ws, flags: { app: 'mobile' } }))).rejects.toThrow(
      /has no release target/,
    );
    await expect(runCsp(makeCtx({ cwd: ws, flags: {} }))).rejects.toThrow(
      '--app=<project> is required.',
    );
    fs.writeFileSync(
      path.join(ws, 'apps/portal/csp-allowlist.json'),
      '{"script-src":["\'unsafe-eval\'"]}',
    );
    await expect(run(ws, {})).rejects.toThrow(
      /apps\/portal\/csp-allowlist.json: .*quoted keywords/,
    );
  });
});

describe('pstack csp --import (NX-49)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const allowlist = (ws: string) =>
    JSON.parse(fs.readFileSync(path.join(ws, 'apps/portal/csp-allowlist.json'), 'utf8'));

  it('merges a hand-written .htaccess policy, reports refused sources, writes the files', async () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, 'apps/portal/src'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'apps/portal/src/.htaccess'),
      "Header always set Content-Security-Policy \"default-src 'self'; script-src 'self' " +
        "'unsafe-inline' https://tags.example.com https://tags.example.com/gtm.js; img-src 'self' " +
        'https://img.example.com"\n',
    );
    await run(ws, { import: 'apps/portal/src/.htaccess', force: true });
    expect(allowlist(ws)).toEqual({
      'connect-src': ['https://api.example.com'],
      'script-src': ['https://tags.example.com'],
      'img-src': ['https://img.example.com'],
    });
    expect(out()).toContain('Imported from apps/portal/src/.htaccess (server-config):');
    expect(out()).toContain(
      '  = script-src: https://tags.example.com/gtm.js (covered by https://tags.example.com)',
    );
    expect(out()).toContain('Refused (the strict policy does not allow them):');
    expect(out()).toContain("  - script-src 'unsafe-inline': quoted keywords");
    expect(read(ws, 'src/.htaccess')).toContain(GENERATED_MARKER);
    expect(read(ws, 'src/.htaccess')).toContain('https://tags.example.com');
  });

  it('takes a policy inline, and a JSON file from the caller folder; --dry-run writes nothing', async () => {
    const ws = workspace();
    await runCsp(
      makeCtx({
        cwd: ws,
        dryRun: true,
        flags: {
          app: 'portal',
          import: 'connect-src https://inline.example.com; frame-src https://f.example.com',
        },
      }),
    );
    expect(allowlist(ws)).toEqual({ 'connect-src': ['https://api.example.com'] });
    expect(out()).toContain('  + frame-src       https://f.example.com');

    fs.mkdirSync(path.join(ws, 'apps/portal/security'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'apps/portal/security/csp.json'),
      JSON.stringify({
        suggestedPolicy: { directives: { 'font-src': ["'self'", 'https://fonts.example.com'] } },
      }),
    );
    await runCsp(
      makeCtx({
        cwd: path.join(ws, 'apps/portal'),
        flags: { app: 'portal', import: 'security/csp.json' },
      }),
    );
    expect(allowlist(ws)['font-src']).toEqual(['https://fonts.example.com']);
  });

  it('leaves the allowlist file untouched when the import adds nothing', async () => {
    const ws = workspace();
    const file = path.join(ws, 'apps/portal/csp-allowlist.json');
    const text = '{"connect-src":["https://api.example.com"]}';
    fs.writeFileSync(file, text);
    await run(ws, { import: 'connect-src https://api.example.com/v1; img-src data:' });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(out()).toContain('  nothing new');
  });

  it('refuses a missing file and invalid JSON', async () => {
    const ws = workspace();
    await expect(run(ws, { import: 'nope.txt' })).rejects.toThrow('--import: no file "nope.txt"');
    await expect(run(ws, { import: 'script-src.txt' })).rejects.toThrow('no file "script-src.txt"');
    fs.writeFileSync(path.join(ws, 'bad.json'), '{ broken');
    await expect(run(ws, { import: 'bad.json' })).rejects.toThrow(
      '--import: bad.json: not valid JSON',
    );
    await expect(run(ws, { import: true })).rejects.toThrow('--import needs a value');
  });

  it('needs plugin 0.38.0 and resolves only existing files when delegating', () => {
    const { assertLocalSupports, delegationArgs } = jest.requireActual('../../src/cli/launcher');
    expect(() => assertLocalSupports('csp', '0.37.0', { app: 'p', import: 'x' })).toThrow(
      'pstack csp --import needs nx-polystack >= 0.38.0',
    );
    const ws = workspace();
    fs.writeFileSync(path.join(ws, 'apps/portal/policy.txt'), "img-src 'self'");
    const args = delegationArgs(
      'csp',
      ['--import=policy.txt', '--app=portal'],
      path.join(ws, 'apps/portal'),
      ws,
    );
    expect(args[0]).toBe(`--import=${path.join(ws, 'apps/portal/policy.txt')}`);
    const inline = "--import=img-src 'self'";
    expect(delegationArgs('csp', [inline], path.join(ws, 'apps/portal'), ws)).toEqual([inline]);
    expect(helpText('0.38.0')).toContain('--import=<file|policy>');
  });

  describe('existing Apache + mod_lua setup (NX-70)', () => {
    const legacyList = {
      'connect-src': ['https://api.example.com'],
      'script-src': [`'sha256-${'A'.repeat(43)}='`],
      'nonce-source': 'env:UNIQUE_ID',
      'unset-headers': ['Content-Security-Policy'],
      'referrer-policy': 'strict-origin',
      'extra-headers': { 'X-DEBUG-UNIQUE-ID': '%{UNIQUE_ID}e' },
      ssi: 'html',
    };

    it('uses UNIQUE_ID as is: no SetEnvIfExpr, %{UNIQUE_ID}e in the header, single-quoted SSI', async () => {
      const ws = workspace();
      writeJson(path.join(ws, 'apps', 'portal', 'csp-allowlist.json'), legacyList);
      await run(ws, {});
      const ht = read(ws, 'src/.htaccess');
      expect(ht).not.toContain('SetEnvIfExpr');
      expect(ht).not.toMatch(/mod_unique_id|mod_setenvif/);
      expect(ht).toContain("'nonce-%{UNIQUE_ID}e'");
      expect(ht).toContain("<!--#echo var='UNIQUE_ID' -->");
      expect(ht).toContain(`'sha256-${'A'.repeat(43)}='`);
      // Order: unset before the policy is set; the debug header as written.
      const lines = ht.split('\n');
      const unset = lines.indexOf('Header always unset Content-Security-Policy');
      const set = lines.findIndex((l) => l.startsWith('Header always set Content-Security-Policy'));
      expect(unset).toBeGreaterThan(-1);
      expect(unset).toBeLessThan(set);
      expect(ht).toContain('Header always set Referrer-Policy "strict-origin"');
      expect(ht).toContain('Header always set X-DEBUG-UNIQUE-ID "%{UNIQUE_ID}e"');
      expect(ht).toContain('Options +Includes\nAddOutputFilter INCLUDES .html');
      expect(ht).toContain('AllowOverride FileInfo Options=Includes ');
      expect(ht).toContain(
        'Header unset Content-Security-Policy\nHeader always unset Content-Security-Policy',
      );
      // Nginx replaces the same placeholder (double-quoted: it holds single quotes).
      expect(read(ws, 'server/nginx.conf')).toContain(
        `sub_filter "<!--#echo var='UNIQUE_ID' -->" $request_id;`,
      );
      // The release target writes the placeholder the server fills.
      const pj = JSON.parse(read(ws, 'project.json'));
      expect(pj.targets.release.options.nonce).toEqual({
        placeholder: "<!--#echo var='UNIQUE_ID' -->",
      });
      expect(out()).toContain("release nonce.placeholder set to <!--#echo var='UNIQUE_ID' -->");
      // The allowlist round-trips unchanged.
      expect(JSON.parse(read(ws, 'csp-allowlist.json'))).toEqual(legacyList);
    });

    it('--nonce-source sets the key; the default output keeps mod_unique_id', async () => {
      const ws = workspace();
      await run(ws, {});
      expect(read(ws, 'src/.htaccess')).toContain("SetEnvIfExpr \"reqenv('UNIQUE_ID')");
      await run(ws, { nonceSource: 'env:UNIQUE_ID' });
      expect(JSON.parse(read(ws, 'csp-allowlist.json'))['nonce-source']).toBe('env:UNIQUE_ID');
      expect(read(ws, 'src/.htaccess')).not.toContain('SetEnvIfExpr');
      await expect(run(ws, { nonceSource: 'env:bad name' })).rejects.toThrow(/nonce-source/);
    });

    it('syncs configurations that set nonce, and resets when going back to mod_unique_id', async () => {
      const ws = workspace();
      const pjFile = path.join(ws, 'apps', 'portal', 'project.json');
      const pj = JSON.parse(fs.readFileSync(pjFile, 'utf8'));
      pj.targets.release.configurations.prod = { env: 'PROD', nonce: { tags: 'legacy' } };
      writeJson(pjFile, pj);
      await run(ws, { nonceSource: 'env:UNIQUE_ID' });
      let rel = JSON.parse(read(ws, 'project.json')).targets.release;
      const P = "<!--#echo var='UNIQUE_ID' -->";
      expect(rel.options.nonce).toEqual({ placeholder: P });
      expect(rel.configurations.prod.nonce).toEqual({ tags: 'legacy', placeholder: P });
      expect(rel.configurations.uat.nonce).toBeUndefined();

      await run(ws, { nonceSource: 'mod_unique_id' });
      rel = JSON.parse(read(ws, 'project.json')).targets.release;
      expect(rel.options.nonce).toBeUndefined();
      expect(rel.configurations.prod.nonce).toEqual({ tags: 'legacy' });
      expect(read(ws, 'src/.htaccess')).toContain('SetEnvIfExpr');
    });

    it('--dry-run reports the placeholder change without writing it', async () => {
      const ws = workspace();
      await runCsp(
        makeCtx({ cwd: ws, dryRun: true, flags: { app: 'portal', nonceSource: 'env:UNIQUE_ID' } }),
      );
      expect(out()).toContain("nonce.placeholder would be set to <!--#echo var='UNIQUE_ID' -->");
      expect(JSON.parse(read(ws, 'project.json')).targets.release.options).toBeUndefined();
    });

    it('--import keeps sha256 hashes from script-src-elem', async () => {
      const ws = workspace();
      const h = `'sha256-${'Zz9+'.repeat(10)}abc='`;
      await run(ws, { import: `script-src-elem 'self' ${h} https://www.googletagmanager.com` });
      expect(JSON.parse(read(ws, 'csp-allowlist.json'))['script-src']).toEqual([
        h,
        'https://www.googletagmanager.com',
      ]);
      expect(read(ws, 'src/.htaccess')).toContain(h);
      expect(out()).toContain('script-src-elem was merged into script-src');
    });

    it('refuses unsafe extra headers and unknown referrer policies', async () => {
      for (const bad of [
        { 'extra-headers': { 'content-security-policy': "default-src * 'unsafe-inline'" } },
        { 'extra-headers': { 'X-Frame-Options': 'ALLOWALL' } },
        { 'script-src': [`'sha256-${'A'.repeat(44)}'`] },
        { 'extra-headers': { 'X-A': 'a" Header set Evil "1' } },
        { 'extra-headers': { 'X A': 'v' } },
        { 'referrer-policy': 'everything' },
        { ssi: 'all' },
      ]) {
        const ws = workspace();
        writeJson(path.join(ws, 'apps', 'portal', 'csp-allowlist.json'), bad);
        await expect(run(ws, {})).rejects.toThrow(/csp-allowlist.json/);
      }
    });
  });
});
