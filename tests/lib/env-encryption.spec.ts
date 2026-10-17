import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  BACKUP_DIR,
  backupEnvFile,
  lockEnvFile,
  markWritten,
  recoverEnvFile,
  removeStaleLock,
  restoreEnvFile,
} from '../../src/lib/env-encryption/backup';
import {
  defaultEnvEncryptionConfig,
  keysFromLegacy,
  loadEnvEncryptionConfig,
  normalizeEnvEncryption,
} from '../../src/lib/env-encryption/config';
import {
  encryptEnvText,
  encryptProfileText,
  setStringFields,
} from '../../src/lib/env-encryption/encrypt';
import {
  appendEnvironmentField,
  environmentFields,
  quotedStrings,
} from '../../src/lib/env-encryption/env-file';
import { decryptGcm, deriveKey } from '../../src/lib/env-encryption/gcm';
import {
  fillPlaceholders,
  parseDotEnv,
  placeholderNames,
  placeholderVars,
} from '../../src/lib/env-encryption/placeholders';
import { prepareEnvFile } from '../../src/lib/env-encryption/prepare';
import { formatStamp } from '../../src/lib/env-encryption/stamp';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CryptoJS = require('crypto-js');
const decrypt = (c: string, k: string) => CryptoJS.AES.decrypt(c, k).toString(CryptoJS.enc.Utf8);

const ENV = `// UAT
export const environment = {
  production: true,
  envName: 'uat', // shown in the footer
  apiBaseUrl: "https://uat.example.com/api",
  password: 'p@ss',
  retries: 3,
  profile: { key: 'nested-key', urls: ['a', 'b'] },
  timeStamp: '',
  branch: '',
};
`;

describe('env-file scanner', () => {
  it('lists top-level fields with kinds and values', () => {
    const f = environmentFields(ENV);
    expect(f.map((x) => [x.key, x.kind])).toEqual([
      ['production', 'other-literal'],
      ['envName', 'string'],
      ['apiBaseUrl', 'string'],
      ['password', 'string'],
      ['retries', 'other-literal'],
      ['profile', 'other-literal'],
      ['timeStamp', 'string'],
      ['branch', 'string'],
    ]);
    const pw = f.find((x) => x.key === 'password')!;
    expect(ENV.slice(pw.start, pw.end)).toBe("'p@ss'");
    expect(pw.text).toBe('p@ss');
  });

  it('classifies expressions, interpolated templates and quoted keys', () => {
    const text =
      "const base = 'x';\nexport const environment: Env = { 'api-url': base + '/api', t: `${base}`, plain: `ok`, fn: get() };";
    expect(environmentFields(text).map((x) => [x.key, x.kind, x.text])).toEqual([
      ['api-url', 'expression', undefined],
      ['t', 'expression', undefined],
      ['plain', 'string', 'ok'],
      ['fn', 'expression', undefined],
    ]);
  });

  it('ignores "environment" inside comments and strings', () => {
    const text =
      "// environment = { x: 1 }\nconst s = 'environment = {';\nexport const environment = { a: 'b' };";
    expect(environmentFields(text).map((x) => x.key)).toEqual(['a']);
  });

  it('skips regex literals and reads hex numbers and as const', () => {
    const text =
      "export const environment = { re: /it's/g, secret: 'abc', n: 0xff, k: 'v' as const };";
    expect(environmentFields(text).map((x) => [x.key, x.kind, x.text])).toEqual([
      ['re', 'expression', undefined],
      ['secret', 'string', 'abc'],
      ['n', 'other-literal', undefined],
      ['k', 'string', 'v'],
    ]);
  });

  it('finds the literal after a leading comment and reads " as " inside strings', () => {
    const text =
      "export const environment = {\n  timeStamp: /* set by build */ '',\n  title: 'Sign in as guest',\n  key:\n    // note\n    'value',\n};";
    const f = environmentFields(text);
    expect(f.map((x) => [x.key, x.kind, x.text])).toEqual([
      ['timeStamp', 'string', ''],
      ['title', 'string', 'Sign in as guest'],
      ['key', 'string', 'value'],
    ]);
    expect(f.map((x) => text.slice(x.start, x.end))).toEqual([
      "''",
      "'Sign in as guest'",
      "'value'",
    ]);
    const stamped = setStringFields(text, { timeStamp: 'NOW' }).text;
    expect(stamped).toContain("timeStamp: /* set by build */ 'NOW',");
    const c = { ...defaultEnvEncryptionConfig(), mode: 'all' as const, publicKeys: ['timeStamp'] };
    const r = encryptEnvText(text, c, 'web', 'k');
    expect(r.encrypted).toEqual(['title', 'key']);
    expect(r.text).toContain('// note');
    expect(decrypt(/key:\n {4}\/\/ note\n {4}'([^']+)'/.exec(r.text)![1], 'k')).toBe('value');
    const l = encryptEnvText(
      "export const environment = { password: 'Sign as x' };",
      { ...defaultEnvEncryptionConfig(), keys: { default: ['password'] } },
      'web',
      'k',
    );
    expect([l.encrypted, l.skipped]).toEqual([['password'], []]);
  });

  it('finds quoted strings outside comments and template literals', () => {
    const text = "a = 'x'; // 'not'\nb = `t ${'in'}`; c = \"y\";";
    expect(quotedStrings(text).map((s) => s.content)).toEqual(['x', 'y']);
  });
});

describe('placeholders', () => {
  it('fills ${NAME} in quoted strings only', () => {
    const text = 'export const environment = { a: \'${A}\', b: "x-${B}", t: `${A}` };';
    const r = fillPlaceholders(text, { A: "it's", B: 'b"q' });
    expect(r.text).toBe('export const environment = { a: \'it\\\'s\', b: "x-b\\"q", t: `${A}` };');
    expect(r.filled).toEqual(['A', 'B']);
    expect(r.missing).toEqual([]);
  });

  it('reports missing variables and leaves them in place', () => {
    const r = fillPlaceholders("x = { a: '${A}', b: '${B}' };", { A: '1' });
    expect(r.missing).toEqual(['B']);
    expect(r.text).toContain("'${B}'");
    expect(placeholderNames("x = { a: '${A}', b: '${B}', c: '${A}' };")).toEqual(['A', 'B']);
  });

  it('parses .env.local', () => {
    expect(
      parseDotEnv('# c\nA=1\nexport B = "two\\nlines"\nC=\'q # not\'\nD=plain # comment\nbad line'),
    ).toEqual({ A: '1', B: 'two\nlines', C: 'q # not', D: 'plain' });
  });

  it('prefers process variables over .env.local', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
    fs.writeFileSync(path.join(dir, '.env.local'), 'A=local\nB=local');
    const vars = placeholderVars(dir, { A: 'env' });
    expect([vars['A'], vars['B'], vars['C']]).toEqual(['env', 'local', undefined]);
  });
});

describe('formatStamp', () => {
  const d = new Date('2026-10-15T00:32:06Z');
  it('formats in the time zone', () => {
    expect(formatStamp(d, 'Asia/Kolkata', 'DD MMM YYYY hh:mm:ss A', undefined)).toBe(
      '15 Oct 2026 06:02:06 AM',
    );
    expect(formatStamp(d, 'UTC', 'YYYY-MM-DD HH:mm:ss z')).toBe('2026-10-15 00:32:06 UTC');
    expect(formatStamp(d, 'Asia/Kolkata', 'HH:mm z', 'IST')).toBe('06:02 IST');
  });
  it('keeps [literal] text', () => {
    expect(formatStamp(new Date('2026-01-01T12:05:00Z'), 'UTC', '[Asia at] HH:mm')).toBe(
      'Asia at 12:05',
    );
  });

  it('uses 12 for noon and midnight in the 12-hour clock', () => {
    expect(formatStamp(new Date('2026-01-01T12:05:00Z'), 'UTC', 'hh A')).toBe('12 PM');
    expect(formatStamp(new Date('2026-01-01T00:05:00Z'), 'UTC', 'hh A')).toBe('12 AM');
  });
});

describe('config', () => {
  it('defaults and validates', () => {
    expect(normalizeEnvEncryption(undefined)).toEqual(defaultEnvEncryptionConfig());
    expect(normalizeEnvEncryption({ mode: 'all', keys: { web: ['a'] } }).keys).toEqual({
      web: ['a'],
      default: [],
    });
    expect(defaultEnvEncryptionConfig().keys).toEqual({ default: [] });
    expect(() => normalizeEnvEncryption({ publicKeys: 'a' })).toThrow(/publicKeys must be a list/);
    expect(() => normalizeEnvEncryption({ stamp: { format: 3 } })).toThrow(
      /stamp.format must be a string/,
    );
    expect(() => normalizeEnvEncryption({ mode: 'some' })).toThrow(/listed or all/);
    expect(() => normalizeEnvEncryption({ cipher: 'des' })).toThrow(/not valid/);
    expect(() => normalizeEnvEncryption({ keys: { web: 'a' } })).toThrow(/list of key names/);
    expect(() => normalizeEnvEncryption({ stamp: { timezone: 'Mars/Base' } })).toThrow(
      /not a known time zone/,
    );
  });

  it('accepts aes-gcm and keySources, maps the old keySource', () => {
    expect(normalizeEnvEncryption({}).keySources).toEqual(['commit']);
    expect(normalizeEnvEncryption({ keySource: 'commit' }).keySources).toEqual(['commit']);
    const c = normalizeEnvEncryption({ cipher: 'aes-gcm', keySources: ['salt', 'commit', 'salt'] });
    expect(c.cipher).toBe('aes-gcm');
    expect(c.keySources).toEqual(['commit', 'salt']);
    expect('keySource' in c).toBe(false);
  });

  it('rejects empty or unknown keySources and unknown ciphers', () => {
    expect(() => normalizeEnvEncryption({ keySources: [] })).toThrow(/keySources/);
    expect(() => normalizeEnvEncryption({ keySources: ['vault'] })).toThrow(/keySources.*vault/);
    expect(() => normalizeEnvEncryption({ keySource: 'env' })).toThrow(/keySource/);
    expect(() => normalizeEnvEncryption({ cipher: 'des' })).toThrow(/cipher "des"/);
  });

  it('reads the legacy keys file', () => {
    expect(keysFromLegacy({ _doc: 'x', _default: ['a'], web: ['b'] })).toEqual({
      default: ['a'],
      web: ['b'],
    });
    // The preset before v0.25.0 wrote {}: nothing was encrypted, and nothing is now.
    expect(keysFromLegacy({})).toEqual({ default: [] });
    expect(keysFromLegacy({ web: ['b'] })).toEqual({ web: ['b'], default: [] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    expect(loadEnvEncryptionConfig(dir)).toMatchObject({
      source: 'default',
      config: { keys: { default: [] } },
    });
    fs.mkdirSync(path.join(dir, 'tools/config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tools/config/encrypt-keys.json'), '{"_default":["x"]}');
    expect(loadEnvEncryptionConfig(dir)).toMatchObject({
      source: 'legacy',
      config: { keys: { default: ['x'] } },
    });
    fs.writeFileSync(
      path.join(dir, 'nx.json'),
      JSON.stringify({ pstack: { envEncryption: { keys: { default: ['y'] } } } }),
    );
    expect(loadEnvEncryptionConfig(dir)).toMatchObject({
      source: 'nx.json',
      config: { keys: { default: ['y'] } },
    });
  });
});

describe('encryptEnvText', () => {
  const cfg = {
    ...defaultEnvEncryptionConfig(),
    keys: { default: ['password', 'uname', 'key', 'iv'] },
  };

  it('listed: encrypts listed keys at any depth (as before) and keeps the rest', () => {
    const r = encryptEnvText(ENV, cfg, 'web', 'abc1234');
    expect(r.encrypted.sort()).toEqual(['key', 'password']);
    const pw = /password: '([^']+)'/.exec(r.text)![1];
    expect(decrypt(pw, 'abc1234')).toBe('p@ss');
    const nested = /key: '([^']+)'/.exec(r.text)![1];
    expect(decrypt(nested, 'abc1234')).toBe('nested-key');
    expect(r.text).toContain('apiBaseUrl: "https://uat.example.com/api"');
  });

  it('listed: per-project keys win over default', () => {
    const c = { ...cfg, keys: { default: ['password'], web: ['apiBaseUrl'] } };
    expect(encryptEnvText(ENV, c, 'web', 'k').encrypted).toEqual(['apiBaseUrl']);
    expect(encryptEnvText(ENV, c, 'admin', 'k').encrypted).toEqual(['password']);
  });

  it('listed: leaves expression values alone and reports them (as before v0.25.0)', () => {
    const text = "export const environment = { password: secretFrom('x'), key: 'k1' };";
    const r = encryptEnvText(text, cfg, 'web', 'k', 'env.ts');
    expect(r.skipped).toEqual(['password']);
    expect(r.encrypted).toEqual(['key']);
    expect(r.text).toContain("password: secretFrom('x')");
  });

  it('listed: encrypts values followed by comments, type assertions or no trailing comma', () => {
    for (const tail of [' // db\n', ' /* c */,\n', ' as string\n', '\n']) {
      const text = `export const environment = {\n  password: 'hunter2'${tail}};`;
      const r = encryptEnvText(text, cfg, 'web', 'k');
      expect(r.encrypted).toEqual(['password']);
      expect(r.skipped).toEqual([]);
      expect(r.text).not.toContain('hunter2');
      expect(decrypt(/password: '([^']+)'/.exec(r.text)![1], 'k')).toBe('hunter2');
    }
  });

  it('encrypts the value the app sees when it has quotes or escapes (both modes)', () => {
    const value = `a\\b'c"d\ne`;
    const filled = fillPlaceholders("export const environment = { password: '${P}' };", {
      P: value,
    });
    for (const mode of ['listed', 'all'] as const) {
      const r = encryptEnvText(filled.text, { ...cfg, mode }, 'web', 'k');
      const m = /password: '([^']+)'/.exec(r.text)!;
      expect(r.text).toBe(`export const environment = { password: '${m[1]}' };`);
      expect(decrypt(m[1], 'k')).toBe(value);
    }
  });

  it('never puts values in error messages', () => {
    const c = { ...cfg, mode: 'all' as const };
    const text = "export const environment = { password: 'TOPSECRET' + sfx };";
    expect(() => encryptEnvText(text, c, 'web', 'k')).toThrow(/password/);
    expect(() => encryptEnvText(text, c, 'web', 'k')).not.toThrow(/TOPSECRET/);
  });

  it('all: fails when no environment object or unkeyed entries are found', () => {
    const c = { ...cfg, mode: 'all' as const };
    expect(() =>
      encryptEnvText("export const environment = Object.freeze({ s: 'x' });", c, 'web', 'k'),
    ).toThrow(/found no environment object/);
    expect(() =>
      encryptEnvText(
        "export const environment = { ...base, secret, [K]: 'v', a: 'b' };",
        c,
        'web',
        'k',
      ),
    ).toThrow(/key: value.*\.\.\.base, secret, \[K\]: 'v'/);
  });

  it('all: encrypts top-level string literals except public keys', () => {
    const c = { ...cfg, mode: 'all' as const };
    const r = encryptEnvText(ENV, c, 'web', 'k');
    expect(r.encrypted).toEqual(['apiBaseUrl', 'password']);
    expect(r.text).toContain("envName: 'uat'");
    expect(r.text).toContain("profile: { key: 'nested-key'");
    const api = /apiBaseUrl: "([^"]+)"/.exec(r.text)![1];
    expect(decrypt(api, 'k')).toBe('https://uat.example.com/api');
  });

  it('all: a stamp field stays plain only when it is a public key', () => {
    const c = { ...cfg, mode: 'all' as const };
    const stamped = setStringFields(ENV, { timeStamp: '15 Oct 2026', branch: 'release/1.2' }).text;
    const r = encryptEnvText(stamped, c, 'web', 'k');
    expect(r.encrypted).toEqual(['apiBaseUrl', 'password', 'branch']);
    expect(r.text).toContain("timeStamp: '15 Oct 2026'");
    expect(r.text).not.toContain('release/1.2');
    const kept = encryptEnvText(
      stamped,
      { ...c, publicKeys: [...c.publicKeys, 'branch'] },
      'web',
      'k',
    );
    expect(kept.text).toContain("branch: 'release/1.2'");
  });

  it('all: fails on non-public expressions, allows public ones', () => {
    const c = { ...cfg, mode: 'all' as const };
    const text = "export const environment = { envName: base + 'x', apiUrl: getUrl() };";
    expect(() => encryptEnvText(text, c, 'web', 'k')).toThrow(/apiUrl/);
    expect(() =>
      encryptEnvText(text, { ...c, publicKeys: [...c.publicKeys, 'apiUrl'] }, 'web', 'k'),
    ).not.toThrow();
  });

  it('sets declared stamp fields', () => {
    const r = setStringFields(ENV, { timeStamp: "15 Oct 2026 'x'", branch: 'main', missing: 'y' });
    expect(r.set).toEqual(['timeStamp', 'branch']);
    expect(r.text).toContain("timeStamp: '15 Oct 2026 \\'x\\''");
    expect(r.text).toContain("branch: 'main'");
  });
});

describe('backup and recovery', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    file = path.join(dir, 'environments/web/environment.uat.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'original');
  });

  it('restores after a normal build', () => {
    backupEnvFile(dir, file);
    fs.writeFileSync(file, 'encrypted');
    restoreEnvFile(dir, file);
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
    expect(fs.readdirSync(path.join(dir, BACKUP_DIR))).toEqual([]);
  });

  it('recovers a killed build from the cache and from a legacy .bak', () => {
    backupEnvFile(dir, file);
    fs.writeFileSync(file, 'encrypted');
    markWritten(dir, file, 'encrypted');
    expect(recoverEnvFile(dir, file)).toEqual({ restored: true, kept: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
    fs.writeFileSync(`${file}.bak`, 'from-bak');
    expect(recoverEnvFile(dir, file)).toEqual({ restored: true, kept: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('from-bak');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it('keeps edits made after a killed build', () => {
    backupEnvFile(dir, file);
    fs.writeFileSync(file, 'encrypted');
    markWritten(dir, file, 'encrypted');
    fs.writeFileSync(file, 'edited by the developer');
    expect(recoverEnvFile(dir, file)).toEqual({ restored: false, kept: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('edited by the developer');
    expect(fs.readdirSync(path.join(dir, BACKUP_DIR))).toEqual([]);
  });

  it('removes only the stale lock it saw (another build may have replaced it)', () => {
    const lock = path.join(dir, 'x.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, token: 'live' }));
    removeStaleLock(lock, 'stale');
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).token).toBe('live');
    removeStaleLock(lock, 'live');
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.includes('.stale.'))).toEqual([]);
  });

  it('keeps an unreadable backup and says so', () => {
    backupEnvFile(dir, file);
    const bdir = path.join(dir, BACKUP_DIR);
    const b = path.join(bdir, fs.readdirSync(bdir)[0]);
    fs.writeFileSync(b, '{');
    expect(() => recoverEnvFile(dir, file)).toThrow(/cannot be read; check the env file/);
    expect(() => restoreEnvFile(dir, file)).toThrow(/cannot be read/);
    expect(fs.existsSync(b)).toBe(true);
  });

  it('locks the env file: same process refused, live holder waited for, dead holder stale', () => {
    const bdir = path.join(dir, BACKUP_DIR);
    const lockName = () => fs.readdirSync(bdir).find((n) => n.endsWith('.lock'));
    const release = lockEnvFile(dir, file);
    expect(() => lockEnvFile(dir, file)).toThrow(/another release build in this process/);
    release();
    expect(lockName()).toBeUndefined();
    const l2 = lockEnvFile(dir, file);
    const lockFile = path.join(bdir, lockName()!);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, token: 'other' }));
    let waited = false;
    expect(() =>
      lockEnvFile(dir, file, { timeoutMs: 50, pollMs: 10, onWait: () => (waited = true) }),
    ).toThrow(/still using/);
    expect(waited).toBe(true);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 4_000_000 + 12345, token: 'dead' }));
    lockEnvFile(dir, file)();
    // This pid with a token it does not hold (pid reused after a crash), another host, or an
    // empty lock file older than a few seconds: stale.
    for (const content of [
      JSON.stringify({ pid: process.pid, token: 'old-run' }),
      JSON.stringify({ pid: process.ppid, host: 'ci-container-1', token: 't' }),
      '',
    ]) {
      fs.writeFileSync(lockFile, content);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lockFile, old, old);
      lockEnvFile(dir, file, { timeoutMs: 50, pollMs: 10 })();
    }
    l2();
    expect(lockName()).toBeUndefined();
  });

  it('leaves other projects backups alone', () => {
    const other = path.join(dir, 'environments/admin/environment.uat.ts');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'admin-original');
    backupEnvFile(dir, other);
    fs.writeFileSync(other, 'admin-encrypted');
    recoverEnvFile(dir, file);
    expect(fs.readFileSync(other, 'utf8')).toBe('admin-encrypted');
  });
});

describe('prepareEnvFile', () => {
  let dir: string;
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const run = (env: string, file: string, vars: Record<string, string> = {}) =>
    prepareEnvFile({
      repoRoot: dir,
      envProject: 'web',
      env,
      envFile: path.join(dir, file),
      commit: 'abc1234',
      branch: 'release/1.2',
      now: new Date('2026-10-15T00:32:06Z'),
      vars,
      log: () => undefined,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-'));
  });

  it('fills, stamps, encrypts and restores', () => {
    write(
      'nx.json',
      JSON.stringify({
        pstack: {
          envEncryption: {
            keys: { default: ['password'] },
            stamp: {
              timezone: 'Asia/Kolkata',
              timezoneLabel: 'IST',
              format: 'DD MMM YYYY HH:mm z',
            },
          },
        },
      }),
    );
    const original = ENV.replace("'p@ss'", "'${DB_PASS}'");
    write('environments/web/environment.uat.ts', original);
    const p = run('UAT', 'environments/web/environment.uat.ts', { DB_PASS: 's3cret' });
    const during = fs.readFileSync(path.join(dir, 'environments/web/environment.uat.ts'), 'utf8');
    expect(during).not.toContain('s3cret');
    expect(during).not.toContain('${DB_PASS}');
    expect(decrypt(/password: '([^']+)'/.exec(during)![1], 'abc1234')).toBe('s3cret');
    expect(during).toContain("timeStamp: '15 Oct 2026 06:02 IST'");
    expect(during).toContain("branch: 'release/1.2'");
    p.restore();
    expect(fs.readFileSync(path.join(dir, 'environments/web/environment.uat.ts'), 'utf8')).toBe(
      original,
    );
  });

  it('fails on a missing variable without touching the file', () => {
    write(
      'environments/web/environment.uat.ts',
      "export const environment = { password: '${X}' };",
    );
    expect(() => run('UAT', 'environments/web/environment.uat.ts')).toThrow(
      /needs X; set it in the environment or in \.env\.local/,
    );
    expect(
      fs.readFileSync(path.join(dir, 'environments/web/environment.uat.ts'), 'utf8'),
    ).toContain('${X}');
    expect(fs.readdirSync(path.join(dir, BACKUP_DIR))).toEqual([]);
  });

  it('DEV: refuses placeholders and changes nothing otherwise', () => {
    write('environments/web/environment.ts', "export const environment = { password: '${X}' };");
    expect(() => run('DEV', 'environments/web/environment.ts', { X: '1' })).toThrow(
      /dev env files must hold literal values/i,
    );
    write('environments/web/environment.ts', "export const environment = { password: 'dev' };");
    const dev = run('DEV', 'environments/web/environment.ts');
    expect(dev.secrets).toEqual([]);
    dev.restore();
    expect(fs.readFileSync(path.join(dir, 'environments/web/environment.ts'), 'utf8')).toContain(
      "'dev'",
    );
  });

  it('without a stamp block (legacy workspace) leaves stamp fields alone', () => {
    write('environments/web/environment.uat.ts', ENV);
    const p = run('UAT', 'environments/web/environment.uat.ts');
    expect(
      fs.readFileSync(path.join(dir, 'environments/web/environment.uat.ts'), 'utf8'),
    ).toContain("timeStamp: ''");
    p.restore();
  });
});

describe('NX-39b: ENC() format and profile files', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { encryptProfileText } = require('../../src/lib/env-encryption/encrypt');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { isSensitiveKey } = require('../../src/lib/env-encryption/sensitive');
  const encCfg = normalizeEnvEncryption({ mode: 'all', format: 'enc' });
  const unwrap = (v: string) => {
    expect(v).toMatch(/^ENC\(.+\)$/);
    return decrypt(v.slice(4, -1), 'k');
  };

  it('format enc wraps values and refuses committed ENC() values', () => {
    const r = encryptEnvText(
      "export const environment = { envName: 'uat', pw: 'p' };",
      encCfg,
      'web',
      'k',
    );
    expect(unwrap(/pw: '([^']+)'/.exec(r.text)![1])).toBe('p');
    expect(() =>
      encryptEnvText("export const environment = { pw: 'ENC(abc)' };", encCfg, 'web', 'k'),
    ).toThrow(/already in ENC\(\.\.\.\)\/ENC2\(\.\.\.\) form.*pw/);
    const listed = normalizeEnvEncryption({ format: 'enc', keys: { default: ['pw'] } });
    expect(() =>
      encryptEnvText("export const environment = { pw: 'ENC(abc)' };", listed, 'web', 'k'),
    ).toThrow(/already in ENC/);
    expect(() => normalizeEnvEncryption({ format: 'zip' })).toThrow(/raw or enc/);
    expect(() => normalizeEnvEncryption({ profileFiles: ['../x.ts'] })).toThrow(
      /inside the env folder/,
    );
  });

  it('recognises sensitive key names', () => {
    for (const k of [
      'password',
      'servicePassword',
      'apiKey',
      'aes_key',
      'clientId',
      'uname',
      'accessToken',
      'otp',
    ])
      expect([k, isSensitiveKey(k)]).toEqual([k, true]);
    for (const k of [
      'key',
      'cacheKey',
      'otpField',
      'getOtp',
      'loginRoute',
      'label',
      'userIdField',
      'isPinSet',
    ])
      expect([k, isSensitiveKey(k)]).toEqual([k, false]);
  });

  it('encrypts sensitive fields and values equal to env secrets in a profile, at any depth', () => {
    const text = `export const profile = {
  routes: { home: '/home' },
  auth: { serviceLogin: { uname: 'svc', password: 'pw' }, apiKey: 'K1', 'clientSecret': "cs" },
  journey: { customer: 'shared-secret', otpField: 'otp' },
  list: ['shared-secret', 'public'],
};`;
    const r = encryptProfileText(text, encCfg, 'k', new Set(['shared-secret']));
    expect(r.encrypted).toEqual(
      expect.arrayContaining([
        'uname',
        'password',
        'apiKey',
        'clientSecret',
        'customer (same value as an env field)',
      ]),
    );
    expect(r.text).toContain("home: '/home'");
    expect(r.text).toContain("otpField: 'otp'");
    expect(r.text).toContain("'public'");
    expect(r.text).toContain("'clientSecret': ");
    expect(r.text).not.toMatch(/'(svc|pw|K1|shared-secret)'|"cs"/);
    expect(unwrap(/apiKey: '([^']+)'/.exec(r.text)![1])).toBe('K1');
  });

  it('prepareEnvFile encrypts profile files with the env file and restores both', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
    fs.writeFileSync(
      path.join(dir, 'nx.json'),
      JSON.stringify({
        pstack: {
          envEncryption: {
            mode: 'all',
            format: 'enc',
            profileFiles: ['app.profile.ts', 'missing.ts'],
          },
        },
      }),
    );
    const envDir = path.join(dir, 'environments/web');
    fs.mkdirSync(envDir, { recursive: true });
    const envText = "export const environment = { envName: 'uat', uname: 'svc-user' };";
    const profText =
      "export const profile = { journey: { customer: 'svc-user' }, auth: { token: 't' } };";
    fs.writeFileSync(path.join(envDir, 'environment.uat.ts'), envText);
    fs.writeFileSync(path.join(envDir, 'app.profile.ts'), profText);
    const logs: string[] = [];
    const p = prepareEnvFile({
      repoRoot: dir,
      envProject: 'web',
      env: 'UAT',
      envFile: path.join(envDir, 'environment.uat.ts'),
      commit: 'k',
      branch: 'b',
      vars: {},
      log: (m) => logs.push(m),
    });
    const prof = fs.readFileSync(path.join(envDir, 'app.profile.ts'), 'utf8');
    expect(prof).not.toContain('svc-user');
    expect(unwrap(/token: '([^']+)'/.exec(prof)![1])).toBe('t');
    expect(logs.join('\n')).toMatch(/app\.profile\.ts: encrypted .*token/);
    expect(logs.join('\n')).not.toMatch(/svc-user/);
    // C7: the profile holds the env value under a non-sensitive key, so it is public.
    expect(p.secrets).toEqual([
      { key: 'uname', value: 'svc-user', public: true },
      { key: 'customer', value: 'svc-user', public: true },
      { key: 'token', value: 't', public: false },
    ]);
    p.restore();
    expect(fs.readFileSync(path.join(envDir, 'app.profile.ts'), 'utf8')).toBe(profText);
    expect(fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8')).toBe(envText);
    expect(fs.readdirSync(path.join(dir, BACKUP_DIR))).toEqual([]);
  });
});

describe('stamp fields in mode all', () => {
  const unwrap = (v: string) => {
    expect(v).toMatch(/^ENC\(.+\)$/);
    return decrypt(v.slice(4, -1), 'k');
  };
  it('encrypts a non-public branch stamp but not profile values equal to it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
    fs.writeFileSync(
      path.join(dir, 'nx.json'),
      JSON.stringify({
        pstack: {
          envEncryption: {
            mode: 'all',
            format: 'enc',
            profileFiles: ['app.profile.ts'],
            stamp: { timeField: 'timeStamp', branchField: 'branchName' },
          },
        },
      }),
    );
    const envDir = path.join(dir, 'environments/web');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(
      path.join(envDir, 'environment.uat.ts'),
      "export const environment = { envName: 'uat', timeStamp: '', branchName: '' };",
    );
    fs.writeFileSync(
      path.join(envDir, 'app.profile.ts'),
      "export const profile = { channel: 'develop' };",
    );
    const p = prepareEnvFile({
      repoRoot: dir,
      envProject: 'web',
      env: 'UAT',
      envFile: path.join(envDir, 'environment.uat.ts'),
      commit: 'k',
      branch: 'develop',
      vars: {},
      log: () => undefined,
    });
    const env = fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8');
    expect(env).not.toContain("'develop'");
    expect(unwrap(/branchName: '([^']+)'/.exec(env)![1])).toBe('develop');
    expect(env).toMatch(/timeStamp: '\d/);
    expect(fs.readFileSync(path.join(envDir, 'app.profile.ts'), 'utf8')).toContain(
      "channel: 'develop'",
    );
    // Stamp values (build time, branch) are not secrets: the leak check does not look for them.
    expect(p.secrets).toEqual([]);
    p.restore();
  });

  it('leaves env values equal to a stamp value out of the leak-check secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
    fs.writeFileSync(
      path.join(dir, 'nx.json'),
      JSON.stringify({
        pstack: {
          envEncryption: {
            mode: 'all',
            stamp: { timeField: 'timeStamp', branchField: 'branchName' },
          },
        },
      }),
    );
    const envDir = path.join(dir, 'environments/web');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(
      path.join(envDir, 'environment.uat.ts'),
      "export const environment = { branchName: '', track: 'develop', pw: 'pw-123456' };",
    );
    const p = prepareEnvFile({
      repoRoot: dir,
      envProject: 'web',
      env: 'UAT',
      envFile: path.join(envDir, 'environment.uat.ts'),
      commit: 'k',
      branch: 'develop',
      vars: {},
      log: () => undefined,
    });
    expect(p.secrets).toEqual([{ key: 'pw', value: 'pw-123456', public: false }]);
    p.restore();
  });

  it('leaves a stamp field the build cannot fill alone instead of failing', () => {
    const c = normalizeEnvEncryption({
      mode: 'all',
      stamp: { timeField: 'timeStamp', branchField: 'branch' },
    });
    const text = "export const environment = { envName: 'uat', branch: getBranch(), pw: 'x' };";
    const r = encryptEnvText(text, c, 'web', 'k');
    expect(r.encrypted).toEqual(['pw']);
    expect(r.text).toContain('branch: getBranch()');
  });
});

describe('profile warnings', () => {
  it('does not warn about sensitive keys holding an empty string', () => {
    const c = normalizeEnvEncryption({ mode: 'all', format: 'enc' });
    const text =
      "export const profile = { reset: { token: '', boLogin: \"\", pin: getPin() }, auth: { token: 't' } };";
    const r = encryptProfileText(text, c, 'k', new Set<string>());
    expect(r.encrypted).toEqual(['token']);
    expect(r.skipped).toEqual(['pin']);
    expect(r.text).toContain("token: ''");
  });
});

describe('NX-39b review fixes', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { encryptProfileText } = require('../../src/lib/env-encryption/encrypt');
  const enc = normalizeEnvEncryption({ mode: 'all', format: 'enc' });

  it('equal values only in property or item positions', () => {
    const text = [
      "import { Lang } from './lang';",
      "type Method = 'POST' | 'GET';",
      'export const profile = {',
      "  lang: 'en',",
      "  method: 'POST' as Method,",
      "  list: ['en', 'x'],",
      "  isEn: (l: string) => l === 'en',",
      '};',
    ].join('\n');
    const r = encryptProfileText(text, enc, 'k', new Set(['en', 'POST', './lang']));
    expect(r.text).toContain("from './lang'");
    expect(r.text).toContain("type Method = 'POST' | 'GET'");
    expect(r.text).toContain("l === 'en'");
    expect(r.text).not.toMatch(/lang: 'en'|method: 'POST'|\['en'/);
  });

  it('reports sensitive keys it cannot encrypt, and encrypts ENC-looking values in raw format', () => {
    const text =
      "export const p = { token: `t`, tokens: ['a'], pin: isProd ? '1' : '2', otpLength: 6, auth: { secret: 's' } };";
    const r = encryptProfileText(text, enc, 'k', new Set());
    expect(r.skipped.sort()).toEqual(['pin', 'token']);
    expect(r.encrypted).toEqual(expect.arrayContaining(['tokens', 'secret']));
    expect(r.text).not.toContain("['a']");
    const raw = normalizeEnvEncryption({ format: 'raw' });
    const r2 = encryptProfileText("export const p = { token: 'ENC(x)' };", raw, 'k', new Set());
    expect(r2.encrypted).toEqual(['token']);
  });

  it('profileFiles: duplicates collapse, env files are refused', () => {
    expect(normalizeEnvEncryption({ profileFiles: ['a.ts', 'a.ts'] }).profileFiles).toEqual([
      'a.ts',
    ]);
    expect(() => normalizeEnvEncryption({ profileFiles: ['environment.prod.ts'] })).toThrow(
      /must not list env files/,
    );
  });

  it('recovers a missing env file from a killed build and encrypts it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miss-'));
    fs.writeFileSync(
      path.join(dir, 'nx.json'),
      JSON.stringify({ pstack: { envEncryption: { keys: { default: ['password'] } } } }),
    );
    const file = path.join(dir, 'environments/web/environment.uat.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export const environment = { password: 'p' };");
    backupEnvFile(dir, file);
    fs.rmSync(file);
    const p = prepareEnvFile({
      repoRoot: dir,
      envProject: 'web',
      env: 'UAT',
      envFile: file,
      commit: 'k',
      branch: 'b',
      vars: {},
      log: () => undefined,
    });
    expect(fs.readFileSync(file, 'utf8')).not.toContain("'p'");
    p.restore();
    expect(fs.readFileSync(file, 'utf8')).toContain("password: 'p'");
  });
});

describe('NX-39b second review: profile positions and messages', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { encryptProfileText } = require('../../src/lib/env-encryption/encrypt');
  const enc = normalizeEnvEncryption({ mode: 'all', format: 'enc' });

  it('never names a value: ternary branches are not keys', () => {
    const text =
      "export const p = { password: isProd ? 'Pr0dS3cret' : 'devpass', mode: isProd ? 'Pr0dS3cret' : 'ENC(abc)' };";
    const r = encryptProfileText(text, enc, 'k', new Set(['devpass']));
    expect(JSON.stringify(r.encrypted)).not.toContain('Pr0dS3cret');
    expect(r.skipped).toEqual(['password']);
    expect(r.text).toBe(text);
  });

  it('leaves types, interfaces, index access, call arguments and ternaries alone', () => {
    const text = [
      "interface P { lang: 'en' | 'hi'; pwd: string }",
      "type T = { lang: 'en' };",
      "const x = m['POST'] ?? check(mode, 'en');",
      "const y = cond ? 'hi' : 'en';",
      'function f(token: string) { return token; }',
      'export const profile = {',
      "  lang: 'en',",
      "  list: ['POST', 'x'],",
      "  nested: { method: 'POST' as Method },",
      '};',
    ].join('\n');
    const r = encryptProfileText(text, enc, 'k', new Set(['en', 'POST']));
    for (const kept of [
      "lang: 'en' | 'hi'",
      "type T = { lang: 'en' }",
      "m['POST']",
      "check(mode, 'en')",
      "cond ? 'hi' : 'en'",
    ]) {
      expect(r.text).toContain(kept);
    }
    expect(r.text).not.toMatch(/ {2}lang: 'en',|list: \['POST'|method: 'POST'/);
    expect(r.encrypted.sort()).toEqual([
      'lang (same value as an env field)',
      'list (same value as an env field)',
      'method (same value as an env field)',
    ]);
    expect(r.skipped).toEqual([]);
  });
});

describe('NX-39b third review: more object-literal contexts', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { encryptProfileText } = require('../../src/lib/env-encryption/encrypt');
  const enc = normalizeEnvEncryption({ mode: 'all', format: 'enc' });

  it.each([
    "export default { password: 'p1', token: 'tk' };",
    "export const profile = createProfile({ password: 'p2' });",
    "export const p = merge(base, { apiKey: 'k2' });",
    "export const p = Object.assign({}, base, { apiKey: 'k2' });",
    "export const users = [{ password: 'p3' }];",
    "export const mk = () => ({ password: 'p4' });",
  ])('encrypts sensitive values in %s', (text) => {
    const r = encryptProfileText(text, enc, 'k', new Set());
    expect(r.text).not.toMatch(/'(p1|tk|p2|k2|p3|p4)'/);
    expect(r.encrypted.length).toBeGreaterThan(0);
  });

  it('warns by key about a sensitive string it could not encrypt', () => {
    const r = encryptProfileText(
      "export const profile = { password: 'a' + 'b' };",
      enc,
      'k',
      new Set(),
    );
    expect(r.skipped).toEqual(['password']);
    expect(r.text).toContain("'a' + 'b'");
  });

  it('does not touch function declarations, blocks or control flow', () => {
    const text = [
      'function f({ token }: { token: string }) { if (x) { return { a: 1 }; } }',
      "const g = () => { const q = 'x'; };",
      'interface I { password: string }',
    ].join('\n');
    const r = encryptProfileText(text, enc, 'k', new Set(['x']));
    expect(r.text).toBe(text);
    expect(r.skipped).toEqual([]);
  });
});

describe('aes-gcm sealing', () => {
  const key = deriveKey(Buffer.alloc(32, 1), 'commit=c', 't', 'i');
  const gcm = normalizeEnvEncryption({ mode: 'all', cipher: 'aes-gcm' });
  const unwrap2 = (text: string, field: string, aad = field) =>
    decryptGcm(key, new RegExp(`${field}: '(ENC2\\([^']+\\))'`).exec(text)![1], aad);

  it('mode all: ENC2 values bound to their field name', () => {
    const r = encryptEnvText(
      "export const environment = { envName: 'uat', password: 'p', apiKey: 'k' };",
      gcm,
      'web',
      key,
    );
    expect(r.encrypted).toEqual(['password', 'apiKey']);
    expect(unwrap2(r.text, 'password')).toBe('p');
    expect(() => unwrap2(r.text, 'password', 'apiKey')).toThrow();
  });

  it('listed mode: AAD is the full property name even when the listed key matches a suffix', () => {
    const listed = normalizeEnvEncryption({ cipher: 'aes-gcm', keys: { default: ['Key'] } });
    const r = encryptEnvText("export const environment = { apiKey: 'k1' };", listed, 'web', key);
    expect(unwrap2(r.text, 'apiKey')).toBe('k1');
  });

  it('profile items use the array property name', () => {
    const r = encryptProfileText(
      "export const p = { tokens: ['t1'], auth: { secret: 's' } };",
      gcm,
      key,
      new Set<string>(),
    );
    const item = /tokens: \['(ENC2\([^']+\))'\]/.exec(r.text)![1];
    expect(decryptGcm(key, item, 'tokens')).toBe('t1');
    expect(unwrap2(r.text, 'secret')).toBe('s');
  });

  it('refuses committed ENC2 values', () => {
    expect(() =>
      encryptEnvText("export const environment = { password: 'ENC2(a.b)' };", gcm, 'web', key),
    ).toThrow(/password/);
    expect(() =>
      encryptProfileText("export const p = { secret: 'ENC2(a.b)' };", gcm, key, new Set<string>()),
    ).toThrow(/secret/);
    expect(() =>
      encryptEnvText("export const environment = { password: 'ENC2(a.b)' };", gcm, 'web', key),
    ).toThrow(/already in ENC\(\.\.\.\)\/ENC2\(\.\.\.\) form/);
  });

  it('listed mode: aes-gcm refuses listed hits outside the environment object; cryptojs keeps them', () => {
    const text =
      "const extra = { token: 'outside' };\nexport const environment = { token: 'in', a: { token: 'nested' } };\nconst after = { token: 'late' };";
    const listed = normalizeEnvEncryption({ cipher: 'aes-gcm', keys: { default: ['token'] } });
    expect(() => encryptEnvText(text, listed, 'web', key)).toThrow(
      /outside the environment object; aes-gcm only decrypts environment fields — move it into environment or unlist it: token\./,
    );
    const inside = encryptEnvText(
      "export const environment = { token: 'in', a: { token: 'nested' } };",
      listed,
      'web',
      key,
    );
    expect(inside.values).toEqual(['in', 'nested']);
    const crypto = normalizeEnvEncryption({ keys: { default: ['token'] } });
    const r = encryptEnvText(text, crypto, 'web', 'pass');
    expect(r.values).toEqual(['outside', 'in', 'nested', 'late']);
  });

  it('sealer refuses a key of the wrong kind for the cipher', () => {
    const env = "export const environment = { password: 'p' };";
    expect(() => encryptEnvText(env, gcm, 'web', 'passphrase')).toThrow(/aes-gcm needs/);
    const crypto = normalizeEnvEncryption({ mode: 'all' });
    expect(() => encryptEnvText(env, crypto, 'web', key)).toThrow(/cryptojs needs/);
    expect(() =>
      encryptProfileText("export const p = { secret: 's' };", gcm, 'pass', new Set<string>()),
    ).toThrow(/aes-gcm needs/);
  });

  it('listed mode: aes-gcm matches quoted keys and binds to their unescaped text', () => {
    const listed = normalizeEnvEncryption({ cipher: 'aes-gcm', keys: { default: ['Key'] } });
    const text =
      "export const environment = { 'my-Key': 'v1', \"a b Key\": 'v2', 'it\\'s Key': 'v3' };";
    const r = encryptEnvText(text, listed, 'web', key);
    expect(r.values).toEqual(['v1', 'v2', 'v3']);
    const sealed = [...r.text.matchAll(/(ENC2\([^']+\))/g)].map((m) => m[1]);
    expect(decryptGcm(key, sealed[0], 'my-Key')).toBe('v1');
    expect(decryptGcm(key, sealed[1], 'a b Key')).toBe('v2');
    expect(decryptGcm(key, sealed[2], "it's Key")).toBe('v3');
    // cryptojs keeps the old match: quoted keys are not listed hits.
    const crypto = normalizeEnvEncryption({ keys: { default: ['Key'] } });
    expect(encryptEnvText(text, crypto, 'web', 'pass').values).toEqual([]);
  });

  it('listed mode: aes-gcm fails when no property name holds the hit', () => {
    const listed = normalizeEnvEncryption({ cipher: 'aes-gcm', keys: { default: ['f(x)'] } });
    expect(() =>
      encryptEnvText("export const environment = { a: c ? f(x) : 'v' };", listed, 'web', key),
    ).toThrow(/no property name.*: f\(x\)\./);
    // A ternary branch is not a property name: refused rather than bound to `token`.
    const ternary = normalizeEnvEncryption({ cipher: 'aes-gcm', keys: { default: ['token'] } });
    expect(() =>
      encryptEnvText("export const environment = { a: c ? token : 'v' };", ternary, 'web', key),
    ).toThrow(/no property name.*: token\./);
  });

  it('listed mode: the AAD is the whole identifier, non-ASCII prefix included', () => {
    const listed = normalizeEnvEncryption({ cipher: 'aes-gcm', keys: { default: ['Key'] } });
    const r = encryptEnvText(
      "export const environment = { \u00f1apiKey: 'k1' };",
      listed,
      'web',
      key,
    );
    const v = /: '(ENC2\([^']+\))'/.exec(r.text)![1];
    expect(decryptGcm(key, v, '\u00f1apiKey')).toBe('k1');
    expect(() => decryptGcm(key, v, 'apiKey')).toThrow();
  });

  it('appends a field to the environment object', () => {
    const t = appendEnvironmentField("export const environment = { a: 'x' };\n", '__pstack', 'v1');
    expect(t).toBe("export const environment = { a: 'x' , __pstack: 'v1' };\n");
    const t2 = appendEnvironmentField(
      'export const environment = {\n  a: 1,\n};\n',
      '__pstack',
      'v',
    );
    expect(t2).toBe("export const environment = {\n  a: 1, __pstack: 'v' };\n");
    const t3 = appendEnvironmentField(
      'export const environment = {\n  a: 1, // note\n};\n',
      '__pstack',
      'v',
    );
    expect(t3).toBe("export const environment = {\n  a: 1, // note\n __pstack: 'v' };\n");
    expect(() => appendEnvironmentField('const x = 1;', '__pstack', 'v')).toThrow(/environment/);
  });
});

describe('prepareEnvFile aes-gcm', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcm-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates nothing when a check fails (missing variable, bad domain, keySplit, profile)', () => {
    const envDir = path.join(dir, 'environments/web');
    fs.mkdirSync(envDir, { recursive: true });
    const file = path.join(envDir, 'environment.uat.ts');
    const original = "export const environment = { password: 'p' };";
    fs.writeFileSync(file, original);
    const salt = path.join(dir, 'tools/config/env-salt');
    const config = (extra: object = {}) =>
      fs.writeFileSync(
        path.join(dir, 'nx.json'),
        JSON.stringify({
          pstack: {
            envEncryption: {
              mode: 'all',
              cipher: 'aes-gcm',
              keySources: ['env', 'salt'],
              ...extra,
            },
          },
        }),
      );
    const run = (o: object = {}, vars: Record<string, string> = { PSTACK_ENV_KEY: 'e' }) =>
      prepareEnvFile({
        repoRoot: dir,
        envProject: 'web',
        env: 'UAT',
        envFile: file,
        commit: 'abc1234',
        branch: 'b',
        vars,
        log: () => undefined,
        ...o,
      });
    config();
    expect(() => run({}, {})).toThrow(/PSTACK_ENV_KEY/);
    expect(fs.existsSync(salt)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(() => run({ domains: ['not a host'] })).toThrow(/not a host/);
    expect(fs.existsSync(salt)).toBe(false);
    expect(() => run({ keySplit: 'meta-only' })).toThrow(/keySplit/);
    expect(fs.existsSync(salt)).toBe(false);
    config({ profileFiles: ['profile.json'] });
    fs.writeFileSync(path.join(envDir, 'profile.json'), '{ "token": "${MISSING_VAR}" }');
    expect(() => run()).toThrow(/MISSING_VAR/);
    expect(fs.existsSync(salt)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('encrypts with ENC2, appends __pstack, returns key parts, restores', () => {
    fs.writeFileSync(
      path.join(dir, 'nx.json'),
      JSON.stringify({
        pstack: {
          envEncryption: { mode: 'all', cipher: 'aes-gcm', keySources: ['commit', 'salt'] },
        },
      }),
    );
    const envDir = path.join(dir, 'environments/web');
    fs.mkdirSync(envDir, { recursive: true });
    const original = "export const environment = { envName: 'uat', password: 'p' };";
    fs.writeFileSync(path.join(envDir, 'environment.uat.ts'), original);
    const logs: string[] = [];
    const now = new Date('2026-10-15T00:00:00.000Z');
    const p = prepareEnvFile({
      repoRoot: dir,
      envProject: 'web',
      env: 'UAT',
      envFile: path.join(envDir, 'environment.uat.ts'),
      commit: 'abc1234',
      branch: 'b',
      now,
      vars: {},
      log: (m) => logs.push(m),
      keySplit: 'meta-bundle',
      domains: ['a.com'],
    });
    const text = fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8');
    expect(text).toMatch(/password: 'ENC2\(/);
    expect(text).toMatch(/__pstack: '[A-Za-z0-9_-]+'/);
    expect(text).not.toContain("'p'");
    expect(p.keyParts).toMatchObject({ time: now.toISOString() });
    expect(p.keyParts!.asset).toBeUndefined();
    expect(logs.join('\n')).toMatch(/created tools\/config\/env-salt/);
    expect(logs.join('\n')).toMatch(/aes-gcm/);
    expect(logs.join('\n')).not.toContain(p.keyParts!.share);
    p.restore();
    expect(fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8')).toBe(original);
  });

  it('meta-bundle-asset returns the asset; cryptojs builds return no key parts', () => {
    const envDir = path.join(dir, 'environments/web');
    fs.mkdirSync(envDir, { recursive: true });
    const file = path.join(envDir, 'environment.uat.ts');
    fs.writeFileSync(file, "export const environment = { password: 'p' };");
    const run = () =>
      prepareEnvFile({
        repoRoot: dir,
        envProject: 'web',
        env: 'UAT',
        envFile: file,
        commit: 'abc1234',
        branch: 'b',
        vars: {},
        log: () => undefined,
        keySplit: 'meta-bundle-asset',
      });
    fs.writeFileSync(
      path.join(dir, 'nx.json'),
      JSON.stringify({ pstack: { envEncryption: { mode: 'all', cipher: 'aes-gcm' } } }),
    );
    const g = run();
    expect(g.keyParts!.asset!.name).toMatch(/^pstack-k\.[0-9a-f]{8}\.bin$/);
    expect(g.keyParts!.asset!.bytes).toHaveLength(32);
    g.restore();
    fs.writeFileSync(
      path.join(dir, 'nx.json'),
      JSON.stringify({ pstack: { envEncryption: { mode: 'all' } } }),
    );
    const c = run();
    expect(c.keyParts).toBeUndefined();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('__pstack');
    expect(text).not.toContain('ENC2(');
    c.restore();
  });
});
