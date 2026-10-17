import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { injectBuildMeta } from '../../src/lib/helpers/inject-meta';

describe('injectBuildMeta', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-meta-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects a <meta name="x-build"> tag inside <head>', () => {
    const file = path.join(tmpDir, 'index.html');
    fs.writeFileSync(file, '<html><head><title>X</title></head><body></body></html>');
    injectBuildMeta({
      indexHtmlPath: file,
      env: 'PROD',
      branch: 'main',
      commit: 'abc123',
      buildNumber: '99',
    });
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toMatch(/<meta name="x-build" content="[A-Za-z0-9+/=]+">/);
    expect(out.indexOf('<meta name="x-build"')).toBeLessThan(out.indexOf('</head>'));
  });

  it('content is base64-encoded JSON with all required fields', () => {
    const file = path.join(tmpDir, 'index.html');
    fs.writeFileSync(file, '<html><head></head><body></body></html>');
    injectBuildMeta({
      indexHtmlPath: file,
      env: 'UAT',
      branch: 'feature/x',
      commit: 'def',
      buildNumber: '7',
    });
    const out = fs.readFileSync(file, 'utf8');
    const m = out.match(/content="([A-Za-z0-9+/=]+)"/);
    expect(m).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(m![1], 'base64').toString('utf8'));
    expect(decoded).toMatchObject({ env: 'UAT', branch: 'feature/x', commit: 'def', build: '7' });
    expect(decoded.timestamp_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(decoded.timestamp_ist).toBeDefined();
  });

  it('throws when indexHtmlPath does not exist', () => {
    expect(() =>
      injectBuildMeta({
        indexHtmlPath: '/nope',
        env: 'D',
        branch: 'b',
        commit: 'c',
        buildNumber: '1',
      }),
    ).toThrow(/not found/i);
  });

  it('replaces an existing x-build meta tag rather than appending a duplicate', () => {
    const file = path.join(tmpDir, 'index.html');
    fs.writeFileSync(file, '<html><head><meta name="x-build" content="OLD"></head></html>');
    injectBuildMeta({ indexHtmlPath: file, env: 'D', branch: 'b', commit: 'c', buildNumber: '1' });
    const out = fs.readFileSync(file, 'utf8');
    const matches = out.match(/<meta name="x-build"/g);
    expect(matches?.length).toBe(1);
    expect(out).not.toContain('OLD');
  });

  it('uses the given time; extra fields cannot overwrite built-in ones', () => {
    const file = path.join(tmpDir, 'index.html');
    fs.writeFileSync(file, '<html><head></head><body></body></html>');
    const now = new Date('2026-10-15T05:13:22.667Z');
    injectBuildMeta({
      indexHtmlPath: file,
      env: 'UAT',
      branch: 'b',
      commit: 'c',
      buildNumber: '1',
      now,
      extra: { k: 'share', env: 'PROD', timestamp_utc: 'x' },
    });
    const html = fs.readFileSync(file, 'utf8');
    const meta = JSON.parse(Buffer.from(/content="([^"]+)"/.exec(html)![1], 'base64').toString());
    expect(meta).toMatchObject({ k: 'share', env: 'UAT', timestamp_utc: now.toISOString() });
  });
});
