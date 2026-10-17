import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { checkLeaks, Secret } from '../../src/lib/hardening/leak-check';

const HINT = 'LEAK_CHECK=warn or "leakCheck": "warn" to report only';

describe('checkLeaks', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-leak-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  const secret = (key: string, value: string, pub = false): Secret => ({
    key,
    value,
    public: pub,
  });

  it('reports a plaintext in js, naming the file and key but not the value', () => {
    write('chunks/main.js', 'const u = "svc-user-01";');
    const r = checkLeaks(root, [secret('uname', 'svc-user-01')], 'fail');
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([
      `${path.join('chunks', 'main.js')}: plaintext of uname (encrypted in the env files)`,
      expect.stringContaining(HINT),
    ]);
    expect(r.errors.join('\n')).not.toContain('svc-user-01');
  });

  it('finds the JSON-escaped form in json and the raw form in html', () => {
    write('assets/config.json', '{"pw":"a\\"bcd"}');
    write('index.html', '<p>tok-1234</p>');
    const r = checkLeaks(root, [secret('pw', 'a"bcd'), secret('token', 'tok-1234')], 'fail');
    expect(r.errors.slice(0, 2)).toEqual([
      `${path.join('assets', 'config.json')}: plaintext of pw (encrypted in the env files)`,
      'index.html: plaintext of token (encrypted in the env files)',
    ]);
  });

  it('matches whole tokens only', () => {
    write('main.js', 'const user_svcx = 1; const svcxs = 2; const $svcx = 3;');
    expect(checkLeaks(root, [secret('uname', 'svcx')], 'fail').errors).toEqual([]);
    write('main.js', 'f("svcx");');
    expect(checkLeaks(root, [secret('uname', 'svcx')], 'fail').errors).toHaveLength(2);
  });

  it('ignores values shorter than 4 characters and 3rdpartylicenses.txt', () => {
    write('main.js', 'f("abc");');
    write('3rdpartylicenses.txt', 'secret-value');
    write('notes.md', 'secret-value');
    expect(checkLeaks(root, [secret('a', 'abc'), secret('b', 'secret-value')], 'fail')).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('lists every key holding the same value once per file', () => {
    write('main.js', 'f("shared-1");');
    const r = checkLeaks(root, [secret('a', 'shared-1'), secret('b', 'shared-1')], 'fail');
    expect(r.errors[0]).toBe('main.js: plaintext of a, b (encrypted in the env files)');
  });

  it('warns about a public value even in fail mode', () => {
    write('main.js', 'f("svc-user");');
    const r = checkLeaks(
      root,
      [secret('uname', 'svc-user', true), secret('customer', 'svc-user', true)],
      'fail',
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toContain('main.js: plaintext of uname, customer');
    expect(r.warnings[0]).toMatch(/non-sensitive key/);
  });

  it('fails when a value is public in one place only', () => {
    write('main.js', 'f("svc-user");');
    const r = checkLeaks(
      root,
      [secret('uname', 'svc-user', false), secret('customer', 'svc-user', true)],
      'fail',
    );
    expect(r.errors).toHaveLength(2);
  });

  it('lists hits as warnings in warn mode and does nothing when off', () => {
    write('main.js', 'f("tok-1234");');
    const warn = checkLeaks(root, [secret('token', 'tok-1234')], 'warn');
    expect(warn.errors).toEqual([]);
    expect(warn.warnings).toHaveLength(2);
    expect(checkLeaks(root, [secret('token', 'tok-1234')], 'off')).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('finds the \\u-escaped and \\x-escaped forms of non-ASCII values', () => {
    write('a.js', 'f("p\\u00e4ss-\\u4e2d");');
    write('b.js', 'f("p\\xe4ss-\\u4e2d");');
    write('c.js', 'f("p\\u00E4ss-\\u4E2D");');
    const r = checkLeaks(root, [secret('pw', 'päss-中')], 'fail');
    expect(r.errors.slice(0, 3)).toEqual([
      'a.js: plaintext of pw (encrypted in the env files)',
      'b.js: plaintext of pw (encrypted in the env files)',
      'c.js: plaintext of pw (encrypted in the env files)',
    ]);
  });

  it('finds the HTML-entity form in html files only', () => {
    write('index.html', '<p title="a&amp;b&quot;c&#39;d&lt;e&gt;">');
    write('main.js', 'f("a&amp;b&quot;c&#39;d&lt;e&gt;");');
    const r = checkLeaks(root, [secret('pw', 'a&b"c\'d<e>')], 'fail');
    expect(r.errors[0]).toBe('index.html: plaintext of pw (encrypted in the env files)');
    expect(r.errors).toHaveLength(2);
  });

  it('treats regex characters in values literally', () => {
    write('main.js', 'f("a.b*c(d)");');
    expect(checkLeaks(root, [secret('k', 'a.b*c(d)')], 'fail').errors).toHaveLength(2);
    expect(checkLeaks(root, [secret('k', 'a.b*c(e)')], 'fail').errors).toEqual([]);
  });
});
