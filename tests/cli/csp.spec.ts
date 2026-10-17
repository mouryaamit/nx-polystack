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
});
