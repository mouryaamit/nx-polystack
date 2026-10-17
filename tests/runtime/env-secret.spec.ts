import { load as loadRuntime } from './load-env-secret';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CryptoJS = require('crypto-js');

/** Loads a fresh copy of the runtime with a fake document; warnings go to `warn`. */
const load = (meta: Record<string, unknown> | null, metaName = 'x-build') =>
  loadRuntime(meta, metaName, { console: { warn } });

const warn = jest.fn();
const COMMIT = 'abc1234';
const enc = (v: string, k = COMMIT) => CryptoJS.AES.encrypt(v, k).toString();
const ENC = (v: string, k = COMMIT) => `ENC(${enc(v, k)})`;

describe('runtime/env-secret', () => {
  beforeEach(() => warn.mockReset());

  it('reads the build meta and tells encrypted values apart', () => {
    const r = load({ commit: COMMIT, env: 'UAT' });
    expect(r.getBuildMeta()).toMatchObject({ commit: COMMIT });
    expect(r.isEncryptedValue(ENC('x'))).toBe(true);
    expect(r.isEncryptedValue(enc('x'))).toBe(true);
    expect(r.isEncryptedValue('https://api.example.com')).toBe(false);
    expect(r.isEncryptedValue('U2FsdGVkX1')).toBe(false);
  });

  it('decrypts ENC() and raw values, leaves plaintext alone', () => {
    const r = load({ commit: COMMIT });
    expect(r.decryptEnvValue(ENC('p@ss\'w"d'))).toBe('p@ss\'w"d');
    expect(r.decryptEnvValue(enc('raw'))).toBe('raw');
    expect(r.decryptEnvValue('plain')).toBe('plain');
    expect(warn).not.toHaveBeenCalled();
  });

  it('never yields the secret with a wrong commit, and warns once without the value', () => {
    // CryptoJS has no authentication: a wrong passphrase usually fails (value returned unchanged,
    // one warning) but can produce garbage. AES-GCM (NX-39c) authenticates values.
    const wrong = load({ commit: 'other' });
    for (let i = 0; i < 20; i++) {
      expect(wrong.decryptEnvValue(ENC('secret-value'))).not.toBe('secret-value');
    }
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('secret-value');
    warn.mockReset();
    const v = ENC('secret-value');
    const none = load(null);
    expect(none.decryptEnvValue(v)).toBe(v);
    expect(none.decryptEnvValue(v)).toBe(v);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('no <meta name="x-build">');
  });

  it('inPlace decrypts the whole environment tree (nested objects and arrays)', () => {
    const r = load({ commit: COMMIT });
    const environment = {
      production: true,
      envName: 'uat',
      uname: ENC('svc-user'),
      product: { auth: { apiKey: ENC('k-123'), label: 'Login' }, list: [ENC('a'), 'b'] },
    };
    const done = r.envReadySync(environment, { inPlace: true });
    expect(done.sort()).toEqual(['product.auth.apiKey', 'product.list.0', 'uname']);
    expect(environment).toEqual({
      production: true,
      envName: 'uat',
      uname: 'svc-user',
      product: { auth: { apiKey: 'k-123', label: 'Login' }, list: ['a', 'b'] },
    });
    expect(r.envSecret('uname')).toBe('svc-user');
  });

  it('sync keys are decrypted at startup without touching the environment object', () => {
    const r = load({ commit: COMMIT });
    const environment = { uname: ENC('u'), password: ENC('p'), apiUrl: 'https://x' };
    expect(r.envReadySync(environment, { sync: ['uname'] })).toEqual(['uname']);
    expect(environment.uname).toMatch(/^ENC\(/);
    expect(r.envSecret('uname')).toBe('u');
    expect(r.envSecret('password')).toBe('p');
    expect(r.envSecret('apiUrl')).toBe('https://x');
    expect(r.envSecret('missing')).toBe('');
    expect(r.envReadySync({ a: ENC('1'), b: 2 }, { sync: 'all' })).toEqual(['a']);
  });

  it('envSecretAsync decrypts on every call and envReady is a promise', async () => {
    const r = load({ commit: COMMIT });
    const environment = { password: ENC('p') };
    await expect(r.envReady(environment)).resolves.toEqual([]);
    await expect(r.envSecretAsync('password')).resolves.toBe('p');
    environment.password = ENC('changed');
    await expect(r.envSecretAsync('password')).resolves.toBe('changed');
  });

  it('needs envReady first and a custom meta name works', async () => {
    const r = load({ commit: COMMIT }, 'x-app');
    expect(() => r.envSecret('a')).toThrow(/envReady/);
    await expect(r.envSecretAsync('a')).rejects.toThrow(/envReady/);
    r.envReadySync({ a: ENC('1') }, { metaName: 'x-app', sync: ['a'] });
    expect(r.envSecret('a')).toBe('1');
  });

  it('warns about read-only fields by path, decrypts null-prototype objects, decryptTree', () => {
    const r = load({ commit: COMMIT });
    const inner = Object.freeze({ password: ENC('p') });
    const bare = Object.assign(Object.create(null), { token: ENC('t') });
    const environment = { uname: ENC('u'), inner, bare };
    const done = r.envReadySync(environment, { inPlace: true });
    expect(done.sort()).toEqual(['bare.token', 'uname']);
    expect(String(warn.mock.calls[0][0])).toContain('inner.password');
    expect(String(warn.mock.calls[0][0])).not.toContain('ENC(');
    const other = { a: { b: ENC('x') } };
    expect(r.decryptTree(other)).toEqual(['a.b']);
    expect(other.a.b).toBe('x');
    expect(r.envSecret('uname')).toBe('u');
  });

  it('meta name resets when not passed, and non-object meta is ignored', () => {
    const r = load({ commit: COMMIT }, 'x-app');
    r.envReadySync({}, { metaName: 'x-app' });
    expect(r.getBuildMeta()).toMatchObject({ commit: COMMIT });
    r.envReadySync({});
    expect(r.getBuildMeta()).toBeNull();
    expect(load(['x'] as unknown as Record<string, unknown>).getBuildMeta()).toBeNull();
  });

  it('keeps the meta name when the same environment is registered again without one', async () => {
    const r = load({ commit: COMMIT }, 'x-app');
    const environment: Record<string, unknown> = { a: ENC('1') };
    await r.envReady(environment, { metaName: 'x-app', inPlace: true });
    expect(environment['a']).toBe('1');
    environment['b'] = ENC('2');
    r.envReadySync(environment);
    expect(r.getBuildMeta()).toMatchObject({ commit: COMMIT });
    r.envReadySync(environment, { inPlace: true });
    expect(environment['b']).toBe('2');
    expect(r.decryptEnvValue(ENC('3'))).toBe('3');
    await r.envReady(environment, { inPlace: true });
    expect(r.getBuildMeta()).toMatchObject({ commit: COMMIT });
    expect(warn).not.toHaveBeenCalled();
    // Another object without metaName falls back to x-build.
    r.envReadySync({});
    expect(r.getBuildMeta()).toBeNull();
  });

  it('envSecret follows a field that changed after it was read', () => {
    const r = load({ commit: COMMIT });
    const e: Record<string, string> = { k: ENC('one') };
    r.envReadySync(e);
    expect(r.envSecret('k')).toBe('one');
    e['k'] = ENC('two');
    r.envReadySync(e);
    expect(r.envSecret('k')).toBe('two');
    const inPlace: Record<string, string> = { k: ENC('x') };
    r.envReadySync(inPlace, { inPlace: true });
    expect(inPlace['k']).toBe('x');
    expect(r.envSecret('k')).toBe('x');
  });

  it('decrypts what the release build writes', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { encryptEnvText } = require('../../src/lib/env-encryption/encrypt');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { normalizeEnvEncryption } = require('../../src/lib/env-encryption/config');
    const cfg = normalizeEnvEncryption({ mode: 'all', format: 'enc' });
    const out = encryptEnvText(
      "export const environment = { envName: 'uat', secret: 'a\\\\b\\'c' };",
      cfg,
      'web',
      COMMIT,
    ).text;
    const secret = /secret: '([^']+)'/.exec(out)![1];
    expect(load({ commit: COMMIT }).decryptEnvValue(secret)).toBe("a\\b'c");
  });
});
