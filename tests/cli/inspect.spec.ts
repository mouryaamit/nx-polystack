import * as fs from 'fs';
import * as path from 'path';

import { runInspect } from '../../src/cli/commands/inspect';
import { NEVER_DELEGATE } from '../../src/cli/launcher';
import { findBuildMeta, generatorInfo } from '../../src/lib/helpers/build-gen';
import { injectBuildMeta } from '../../src/lib/helpers/inject-meta';

import { makeCtx, tmpDir } from './helpers';

function dist(gen: Parameters<typeof injectBuildMeta>[0]['gen'], extra?: Record<string, string>) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'browser'), { recursive: true });
  const index = path.join(dir, 'browser', 'index.html');
  fs.writeFileSync(
    index,
    '<html><head><meta property="csp-nonce" content="x"></head><body></body></html>',
  );
  injectBuildMeta({
    indexHtmlPath: index,
    env: 'PROD',
    branch: 'master',
    commit: 'abc1234',
    buildNumber: '42',
    metaName: 'x-app',
    gen,
    extra,
  });
  return dir;
}

describe('build gen info (NX-85)', () => {
  it('names the plugin and the installed Angular and Nx', () => {
    const ws = tmpDir();
    for (const [pkg, v] of [
      ['@angular/core', '21.2.9'],
      ['nx', '22.7.12'],
    ]) {
      fs.mkdirSync(path.join(ws, 'node_modules', pkg), { recursive: true });
      fs.writeFileSync(path.join(ws, 'node_modules', pkg, 'package.json'), `{"version":"${v}"}`);
    }
    expect(generatorInfo(ws, undefined, '1.2.8')).toEqual({
      gen: 'nx-polystack@1.2.8',
      ng: '21.2.9',
      nx: '22.7.12',
    });
    expect(generatorInfo(ws, { gen: false })).toBeUndefined();
    expect(() => generatorInfo(ws, [] as never)).toThrow('buildMeta must be an object');
  });

  it('finds a build meta under any name and ignores other metas', () => {
    const html =
      '<meta name="viewport" content="width=device-width">' +
      `<meta name="x-app" content="${Buffer.from(
        JSON.stringify({ env: 'UAT', timestamp_utc: 't', commit: 'c' }),
      ).toString('base64')}">` +
      `<meta name="other" content="${Buffer.from('{"a":1}').toString('base64')}">`;
    const found = findBuildMeta(html);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('x-app');
  });
});

describe('pstack inspect', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    jest.spyOn(console, 'log').mockImplementation((m: string) => {
      out.push(m);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('reports a pstack build from a dist folder (browser/ layout, renamed meta)', async () => {
    const dir = dist({ gen: 'nx-polystack@1.2.8', ng: '21.2.9', nx: '22.7.12' });
    expect(await runInspect(makeCtx({ positionals: [dir] }))).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Built by pstack: nx-polystack@1.2.8 (Angular 21.2.9, Nx 22.7.12)');
    expect(text).toContain('<meta name="x-app">');
    expect(text).toContain('commit:    abc1234');
    expect(text).toContain('csp nonce');
  });

  it('says when the tool fields are missing and never prints the key share', async () => {
    const dir = dist(undefined, { k: 'SECRET-SHARE' });
    expect(await runInspect(makeCtx({ positionals: [dir], flags: { json: true } }))).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.pstack).toBe(false);
    expect(json.buildMeta[0].payload.k).toBe('(aes-gcm key share, not shown)');
    expect(out.join('\n')).not.toContain('SECRET-SHARE');

    out = [];
    await runInspect(makeCtx({ positionals: [dir] }));
    expect(out.join('\n')).toContain('without the tool fields');
    expect(out.join('\n')).not.toContain('SECRET-SHARE');
  });

  it('exits 1 when there is no build meta, and errors on a missing path', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head></html>');
    expect(await runInspect(makeCtx({ positionals: [dir] }))).toBe(1);
    await expect(runInspect(makeCtx({ positionals: [path.join(dir, 'nope')] }))).rejects.toThrow(
      'does not exist',
    );
    await expect(runInspect(makeCtx({}))).rejects.toThrow('give a dist folder');
  });

  it('runs in the global CLI (never delegated to an older pinned plugin)', () => {
    expect(NEVER_DELEGATE.has('inspect')).toBe(true);
  });
});
