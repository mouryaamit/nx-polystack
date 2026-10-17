import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeEnvEncryption } from '../../src/lib/env-encryption/config';
import { decodePstack, encodePstack, encryptGcm } from '../../src/lib/env-encryption/gcm';
import { buildKeyMaterial } from '../../src/lib/env-encryption/key-material';

import { load } from './load-env-secret';

function build(opts: {
  split?: 'meta-bundle' | 'meta-bundle-asset';
  sources?: string[];
  domains?: string[];
  onMismatch?: 'block' | 'warn';
  custom?: string;
  requireIntegrity?: boolean;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const config = normalizeEnvEncryption({
    cipher: 'aes-gcm',
    keySources: opts.sources ?? ['commit'],
  });
  const m = buildKeyMaterial({
    repoRoot: dir,
    config,
    envProject: 'web',
    env: 'UAT',
    commit: 'abc1234',
    now: new Date('2026-10-15T00:00:00.000Z'),
    vars: { PSTACK_CUSTOM_KEY: opts.custom },
    keySplit: opts.split ?? 'meta-bundle',
    domains: opts.domains,
    onMismatch: opts.onMismatch,
    requireIntegrity: opts.requireIntegrity,
  });
  const environment = {
    envName: 'uat',
    password: encryptGcm(m.key, 'p@ss', 'password'),
    nested: { token: encryptGcm(m.key, 't', 'token'), list: [encryptGcm(m.key, 'i1', 'list')] },
    __pstack: m.field,
  } as Record<string, unknown>;
  const meta = { commit: 'abc1234', timestamp_utc: m.parts.time, k: m.parts.share };
  return { m, environment, meta };
}

/** Every argument of every call of a console mock, as one string. */
const said = (fn: jest.Mock) => fn.mock.calls.flat().map(String).join(' ');

/** Strings that must never reach an error or a console message. */
function secretsOf(b: ReturnType<typeof build>): string[] {
  const p = decodePstack(b.m.field);
  return ['p@ss', 'i1', b.meta.k, p.b, b.m.key.toString('base64url'), b.m.key.toString('hex')];
}

describe('runtime aes-gcm', () => {
  it('envReady decrypts in place (nested and arrays) and removes __pstack', async () => {
    const { environment, meta } = build({});
    const r = load(meta);
    const done = await r.envReady(environment, { inPlace: true });
    expect(done.sort()).toEqual(['nested.list.0', 'nested.token', 'password']);
    expect(environment).toMatchObject({ password: 'p@ss', nested: { token: 't', list: ['i1'] } });
    expect('__pstack' in environment).toBe(false);
    expect(r.envSecret('password')).toBe('p@ss');
    expect(r.getBuildMeta()).not.toHaveProperty('k');
    expect(r.getBuildMeta()).toMatchObject({ commit: 'abc1234' });
  });

  it('envSecretAsync decrypts without inPlace; sync envSecret throws on ENC2', async () => {
    const { environment, meta } = build({});
    const r = load(meta);
    await r.envReady(environment);
    await expect(r.envSecretAsync('password')).resolves.toBe('p@ss');
    expect(() => r.envSecret('password')).toThrow(/aes-gcm/);
    // A second envReady on the same object (the field is gone by then) keeps the key.
    await r.envReady(environment);
    await expect(r.envSecretAsync('password')).resolves.toBe('p@ss');
    await expect(r.envReady(environment, { sync: ['password'] })).resolves.toEqual(['password']);
    expect(r.envSecret('password')).toBe('p@ss');
  });

  it('envReadySync leaves ENC2 values alone', () => {
    const { environment, meta } = build({});
    const r = load(meta);
    expect(r.envReadySync(environment, { inPlace: true })).toEqual([]);
    expect(String(environment['password'])).toMatch(/^ENC2\(/);
    expect(r.isEncryptedValue(environment['password'])).toBe(true);
    expect(r.decryptEnvValue(String(environment['password']))).toBe(environment['password']);
  });

  it('meta-bundle-asset fetches the third share', async () => {
    const { m, environment, meta } = build({ split: 'meta-bundle-asset' });
    const fetch = jest.fn(async (url: string) => {
      expect(url).toBe(`https://app.example.com/portal/assets/${m.parts.asset!.name}`);
      const b = m.parts.asset!.bytes;
      return {
        ok: true,
        arrayBuffer: async () =>
          b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer,
      };
    });
    const r = load(meta, 'x-build', { fetch });
    await r.envReady(environment, { inPlace: true });
    expect(environment['password']).toBe('p@ss');
    expect(fetch).toHaveBeenCalledTimes(1);
    const missing = build({ split: 'meta-bundle-asset' });
    const notFound = jest.fn(async () => ({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(
      load(missing.meta, 'x-build', { fetch: notFound }).envReady(missing.environment),
    ).rejects.toThrow(/key asset/);
  });

  it('a key asset of the wrong length points at an SPA fallback', async () => {
    const b = build({ split: 'meta-bundle-asset' });
    const html = new TextEncoder().encode('<!doctype html><html></html>');
    const fallback = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => html.buffer.slice(0) as ArrayBuffer,
    }));
    await expect(
      load(b.meta, 'x-build', { fetch: fallback }).envReady(b.environment),
    ).rejects.toThrow(
      'the key asset could not be loaded (got a different file — check the server serves ' +
        'assets/ before any SPA fallback)',
    );
  });

  it('ENC2 values without __pstack: one console error, no values', async () => {
    const b = build({});
    delete b.environment['__pstack'];
    const error = jest.fn();
    const r = load(b.meta, 'x-build', { console: { error } });
    await r.envReady(b.environment, { inPlace: true });
    expect(error).toHaveBeenCalledTimes(1);
    expect(said(error)).toBe(
      '[env-secret] aes-gcm values but no __pstack field (was the env file built by the release ' +
        'target?)',
    );
    expect(String(b.environment['password'])).toMatch(/^ENC2\(/);
    for (const s of secretsOf(b)) expect(said(error)).not.toContain(s);
  });

  it('custom source: getKey is required and must match', async () => {
    const a = build({ sources: ['commit', 'custom'], custom: 'srv' });
    await expect(load(a.meta).envReady(a.environment, { inPlace: true })).rejects.toThrow(/getKey/);
    const b = build({ sources: ['commit', 'custom'], custom: 'srv' });
    const error = jest.fn();
    await load(b.meta, 'x-build', { console: { error } }).envReady(b.environment, {
      inPlace: true,
      getKey: async () => 'wrong',
    });
    expect(String(b.environment['password'])).toMatch(/^ENC2\(/);
    expect(said(error)).toMatch(/password/);
    for (const s of [...secretsOf(b), 'srv', 'wrong']) expect(said(error)).not.toContain(s);
    const c = build({ sources: ['commit', 'custom'], custom: 'srv' });
    await load(c.meta).envReady(c.environment, { inPlace: true, getKey: () => 'srv' });
    expect(c.environment['password']).toBe('p@ss');
  });

  it('a tampered share fails authentication by path, without secrets in the message', async () => {
    const b = build({});
    const error = jest.fn();
    // The first character carries 6 full bits of the share (never base64 padding).
    const k = b.meta.k.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    const r = load({ ...b.meta, k }, 'x-build', { console: { error } });
    expect(await r.envReady(b.environment, { inPlace: true })).toEqual([]);
    expect(said(error)).toMatch(/password/);
    expect(said(error)).toMatch(/nested\.list\.0/);
    for (const s of [...secretsOf(b), k]) expect(said(error)).not.toContain(s);
    await expect(r.envSecretAsync('password')).rejects.toThrow(/could not decrypt password/);
  });

  it('a malformed ENC2 value is a failure reported by path, the others still decrypt', async () => {
    const b = build({});
    const good = String(b.environment['password']);
    const [iv, data] = good.slice('ENC2('.length, -1).split('.');
    Object.assign(b.environment, {
      noDot: `ENC2(${iv}${data})`,
      twoDots: `ENC2(${iv}.${data}.x)`,
      shortIv: `ENC2(${iv.slice(4)}.${data})`,
      badChars: `ENC2(${iv}.!!${data})`,
      oneChar: `ENC2(${iv}.${data.slice(0, 5)})`,
    });
    const error = jest.fn();
    const r = load(b.meta, 'x-build', { console: { error } });
    const done = await r.envReady(b.environment, { inPlace: true });
    expect(done.sort()).toEqual(['nested.list.0', 'nested.token', 'password']);
    for (const at of ['noDot', 'twoDots', 'shortIv', 'badChars', 'oneChar']) {
      expect(said(error)).toContain(at);
      expect(String(b.environment[at])).toMatch(/^ENC2\(/);
    }
    for (const s of secretsOf(b)) expect(said(error)).not.toContain(s);
    await expect(r.envSecretAsync('noDot')).rejects.toThrow(/could not decrypt noDot/);
  });

  it('decodes unpadded base64url (length mod 4 of 2 and 3) from Node', async () => {
    const b = build({});
    const p = decodePstack(b.m.field);
    const mods = new Set<number>();
    const environment: Record<string, unknown> = {};
    const expected: Record<string, string> = {};
    for (let n = 0; n < 6; n++) {
      const plain = 'x'.repeat(n);
      const v = encryptGcm(b.m.key, plain, `v${n}`);
      mods.add(v.slice(0, -1).split('.')[1].length % 4);
      environment[`v${n}`] = v;
      expected[`v${n}`] = plain;
    }
    expect([...mods].sort()).toEqual([0, 2, 3]);
    expect(b.meta.k.length % 4).toBe(3);
    for (let pad = 0; pad < 3; pad++) {
      // Vary the __pstack length (the runtime ignores unknown fields).
      const field = encodePstack({ ...p, x: 'y'.repeat(pad) } as typeof p);
      mods.add(field.length % 4);
      const env = { ...environment, __pstack: field };
      const r = load(b.meta);
      await r.envReady(env, { inPlace: true });
      for (let n = 1; n < 6; n++) expect(env[`v${n}`]).toBe(expected[`v${n}`]);
      // '' is an empty plaintext: decrypted, so the field becomes ''.
      expect(env['v0']).toBe('');
      expect(field.endsWith('=')).toBe(false);
    }
    expect(mods.has(2) && mods.has(3)).toBe(true);
  });

  it('rejects an invalid __pstack with a clear error and no values', async () => {
    const b = build({});
    const p = decodePstack(b.m.field);
    const bad = [
      'not base64 json!',
      Buffer.from('not json').toString('base64url'),
      encodePstack({ ...p, v: 1 as 2 }),
      encodePstack({ ...p, b: 3 as unknown as string }),
      encodePstack({ ...p, p: undefined as unknown as string }),
      encodePstack({ ...p, e: 'a|b' }),
      encodePstack({ ...p, s: [] }),
      encodePstack({ ...p, s: 'commit' as unknown as [] }),
      Buffer.from('[1,2]').toString('base64url'),
      Buffer.from('null').toString('base64url'),
    ];
    for (const field of bad) {
      const env = { ...b.environment, __pstack: field };
      const err = await load(b.meta)
        .envReady(env, { inPlace: true })
        .then(
          () => undefined,
          (e: Error) => e,
        );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/^\[env-secret\] .*__pstack/);
      for (const s of [...secretsOf(b), field]) expect(err!.message).not.toContain(s);
    }
  });

  it('a read-only environment keeps its fields; envSecret still returns top-level ones', async () => {
    const b = build({});
    const warn = jest.fn();
    const env = Object.freeze({ ...b.environment });
    const r = load(b.meta, 'x-build', { console: { warn } });
    // Object.freeze is shallow: the nested object is still writable.
    expect((await r.envReady(env, { inPlace: true })).sort()).toEqual([
      'nested.list.0',
      'nested.token',
    ]);
    expect(said(warn)).toContain('password');
    expect(said(warn)).not.toContain('p@ss');
    expect(r.envSecret('password')).toBe('p@ss');
  });

  it('domain lock: block decrypts nothing, warn decrypts, localhost and capacitor pass', async () => {
    const blocked = build({ domains: ['a.com'] });
    const error = jest.fn();
    const r = load(blocked.meta, 'x-build', { hostname: 'evil.com', console: { error } });
    expect(await r.envReady(blocked.environment, { inPlace: true })).toEqual([]);
    expect(String(blocked.environment['password'])).toMatch(/^ENC2\(/);
    expect(said(error)).toMatch(/not allowed/);
    expect(said(error)).not.toContain('a.com');
    await expect(r.envSecretAsync('password')).rejects.toThrow(/not allowed/);
    expect(() => r.envSecret('password')).toThrow(/not allowed/);
    const warned = build({ domains: ['a.com'], onMismatch: 'warn' });
    const warn = jest.fn();
    await load(warned.meta, 'x-build', { hostname: 'evil.com', console: { warn } }).envReady(
      warned.environment,
      { inPlace: true },
    );
    expect(warned.environment['password']).toBe('p@ss');
    expect(said(warn)).not.toContain('a.com');
    for (const loc of [
      { hostname: 'www.a.com' },
      { hostname: 'a.com.' },
      { hostname: 'WWW.A.COM.' },
      { hostname: 'localhost' },
      { hostname: 'localhost.' },
      { hostname: 'x', protocol: 'capacitor:' },
    ]) {
      const ok = build({ domains: ['a.com'] });
      await load(ok.meta, 'x-build', loc).envReady(ok.environment, { inPlace: true });
      expect(ok.environment['password']).toBe('p@ss');
    }
  });

  it('envReadySync on the same environment keeps the key and the blocked state', async () => {
    const b = build({});
    const r = load(b.meta);
    await r.envReady(b.environment, { sync: ['password'] });
    r.envReadySync(b.environment);
    await expect(r.envSecretAsync('password')).resolves.toBe('p@ss');
    const blocked = build({ domains: ['a.com'] });
    const rb = load(blocked.meta, 'x-build', { hostname: 'evil.com' });
    await rb.envReady(blocked.environment);
    rb.envReadySync(blocked.environment);
    await expect(rb.envSecretAsync('password')).rejects.toThrow(/not allowed/);
    // Another environment object starts over.
    rb.envReadySync({ password: blocked.environment['password'] });
    await expect(rb.envSecretAsync('password')).rejects.toThrow(/await envReady/);
  });

  it('decryptTreeAsync decrypts any object tree with the registered key', async () => {
    const b = build({});
    const profile = {
      name: 'n',
      card: { pin: encryptGcm(b.m.key, '1234', 'pin'), holder: 'h' },
      tags: [{ secret: encryptGcm(b.m.key, 's', 'secret') }],
      wrong: encryptGcm(b.m.key, 'x', 'other'),
    };
    const error = jest.fn();
    const r = load(b.meta, 'x-build', { console: { error } });
    await expect(r.decryptTreeAsync(profile)).rejects.toThrow(
      /^\[env-secret\] await envReady\(environment\) first$/,
    );
    await r.envReady(b.environment);
    expect((await r.decryptTreeAsync(profile)).sort()).toEqual(['card.pin', 'tags.0.secret']);
    expect(profile).toMatchObject({ card: { pin: '1234' }, tags: [{ secret: 's' }] });
    expect(String(profile.wrong)).toMatch(/^ENC2\(/);
    expect(said(error)).toContain('wrong');
    expect(said(error)).not.toContain('1234');
    const blocked = build({ domains: ['a.com'] });
    const rb = load(blocked.meta, 'x-build', { hostname: 'evil.com' });
    await rb.envReady(blocked.environment);
    await expect(rb.decryptTreeAsync({ a: blocked.environment['password'] })).rejects.toThrow(
      /not allowed/,
    );
  });

  it('needs Web Crypto for ENC2 values', async () => {
    for (const crypto of [undefined, {}]) {
      const b = build({});
      await expect(
        load(b.meta, 'x-build', { crypto }).envReady(b.environment, { inPlace: true }),
      ).rejects.toThrow(/^\[env-secret\] aes-gcm needs Web Crypto \(https or localhost\)$/);
    }
  });

  it('file: pages are not exempt from the domain lock', async () => {
    const b = build({ domains: ['a.com'] });
    const r = load(b.meta, 'x-build', { hostname: '', protocol: 'file:' });
    expect(await r.envReady(b.environment, { inPlace: true })).toEqual([]);
    expect(String(b.environment['password'])).toMatch(/^ENC2\(/);
  });

  it('envSecret names a value that failed to decrypt', async () => {
    for (const opts of [{ sync: ['password'] }, { inPlace: true }]) {
      const b = build({});
      const k = b.meta.k.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
      const r = load({ ...b.meta, k });
      await r.envReady(b.environment, opts);
      expect(() => r.envSecret('password')).toThrow(/^\[env-secret\] could not decrypt password$/);
    }
  });

  it('__pstack without ENC2 values: no key is derived, the domain lock still applies', async () => {
    const b = build({ split: 'meta-bundle-asset', domains: ['a.com'] });
    const fetch = jest.fn();
    // A plain value (and no Web Crypto, no asset fetch) works like the cryptojs path.
    const plain = { apiUrl: 'https://x', __pstack: b.environment['__pstack'] };
    const r = load(b.meta, 'x-build', { fetch, crypto: undefined, hostname: 'a.com' });
    expect(await r.envReady(plain, { sync: 'all' })).toEqual([]);
    expect(r.envSecret('apiUrl')).toBe('https://x');
    expect(fetch).not.toHaveBeenCalled();
    const error = jest.fn();
    const evil = { apiUrl: 'https://x', __pstack: b.environment['__pstack'] };
    const rb = load(b.meta, 'x-build', { hostname: 'evil.com', console: { error } });
    expect(await rb.envReady(evil, { sync: 'all' })).toEqual([]);
    expect(said(error)).toMatch(/not allowed/);
  });

  it('a concurrent envReady on another object does not get the first key', async () => {
    const a = build({});
    const b = build({});
    const r = load(a.meta);
    const pending = r.envReady(a.environment, { inPlace: true });
    r.envReadySync(b.environment);
    await pending;
    expect(a.environment['password']).toBe('p@ss');
    await expect(r.envSecretAsync('password')).rejects.toThrow(/await envReady/);
  });

  it('binds quoted/hyphenated keys and objects inside arrays to their own property name', async () => {
    const b = build({});
    Object.assign(b.environment, {
      'my-key': encryptGcm(b.m.key, 'mk', 'my-key'),
      items: [{ secret: encryptGcm(b.m.key, 's1', 'secret') }, 'plain'],
    });
    const r = load(b.meta);
    const done = await r.envReady(b.environment, { inPlace: true });
    expect(done).toEqual(expect.arrayContaining(['my-key', 'items.0.secret']));
    expect(b.environment['my-key']).toBe('mk');
    expect(b.environment['items']).toEqual([{ secret: 's1' }, 'plain']);
    expect(r.envSecret('my-key')).toBe('mk');
  });

  it('a hostname with a trailing dot matches a wildcard entry', async () => {
    const b = build({ domains: ['*.a.com'] });
    await load(b.meta, 'x-build', { hostname: 'x.a.com.' }).envReady(b.environment, {
      inPlace: true,
    });
    expect(b.environment['password']).toBe('p@ss');
  });

  it('decryptTreeAsync derives the key on first use when the environment had no ENC2 value', async () => {
    const b = build({ sources: ['commit', 'custom'], custom: 'srv' });
    const env = { apiUrl: 'https://x', __pstack: b.environment['__pstack'] };
    const profile = { auth: { secret: encryptGcm(b.m.key, 'top', 'secret') } };
    const getKey = jest.fn(() => 'srv');
    const r = load(b.meta);
    expect(await r.envReady(env, { inPlace: true, getKey })).toEqual([]);
    expect(getKey).not.toHaveBeenCalled();
    expect(await r.decryptTreeAsync(profile)).toEqual(['auth.secret']);
    expect(profile.auth.secret).toBe('top');
    const again = { s: encryptGcm(b.m.key, 'two', 's') };
    expect(await r.decryptTreeAsync(again)).toEqual(['s']);
    expect(getKey).toHaveBeenCalledTimes(1);
    // No __pstack registered: still needs envReady.
    const plain = load(b.meta);
    await plain.envReady({ apiUrl: 'https://x' });
    await expect(plain.decryptTreeAsync({ a: encryptGcm(b.m.key, 'x', 'a') })).rejects.toThrow(
      /^\[env-secret\] await envReady\(environment\) first$/,
    );
  });

  it('an ENC2 value deep in arrays and objects of the environment triggers derivation', async () => {
    const b = build({});
    const env = {
      cfg: { list: ['plain', { inner: [encryptGcm(b.m.key, 'deep', 'inner')] }] },
      __pstack: b.environment['__pstack'],
    };
    const r = load(b.meta);
    expect(await r.envReady(env, { inPlace: true })).toEqual(['cfg.list.1.inner.0']);
    expect(env.cfg.list[1]).toEqual({ inner: ['deep'] });
  });

  it('requireIntegrity: a script without integrity rejects envReady and decrypts nothing', async () => {
    const b = build({ requireIntegrity: true });
    expect(decodePstack(b.m.field).ri).toBe(1);
    const r = load(b.meta, 'x-build', { scripts: ['sha384-a', null] });
    await expect(r.envReady(b.environment, { inPlace: true })).rejects.toThrow(
      '[env-secret] integrity required: a script has no integrity attribute',
    );
    expect(String(b.environment['password'])).toMatch(/^ENC2\(/);
    await expect(r.envSecretAsync('password')).rejects.toThrow();
    // A second call (the field is gone by then) is checked again.
    await expect(r.envReady(b.environment, { inPlace: true })).rejects.toThrow(/integrity/);
    const blank = build({ requireIntegrity: true });
    await expect(
      load(blank.meta, 'x-build', { scripts: ['  '] }).envReady(blank.environment),
    ).rejects.toThrow(/integrity required/);
  });

  it('requireIntegrity: every script with integrity decrypts', async () => {
    const b = build({ requireIntegrity: true });
    const r = load(b.meta, 'x-build', { scripts: ['sha384-a', 'sha384-b'] });
    await r.envReady(b.environment, { inPlace: true });
    expect(b.environment['password']).toBe('p@ss');
  });

  it('requireIntegrity: third-party scripts are left to the CSP; same-origin and blob/data are checked', async () => {
    const b = build({ requireIntegrity: true });
    const r = load(b.meta, 'x-build', {
      scripts: [
        { src: 'https://www.googletagmanager.com/gtm.js?id=X', integrity: null },
        { src: '//cdn.example.net/chat.js', integrity: null },
        { src: 'runtime.abc.js', integrity: 'sha384-a' },
        { src: '/portal/main.abc.js', integrity: 'sha384-b' },
        { src: 'https://app.example.com/portal/x.js', integrity: 'sha384-c' },
      ],
    });
    await r.envReady(b.environment, { inPlace: true });
    expect(b.environment['password']).toBe('p@ss');

    for (const src of [
      'https://app.example.com/portal/evil.js',
      '/portal/evil.js',
      'blob:https://app.example.com/0b1c',
      'data:text/javascript,alert(1)',
    ]) {
      const c = build({ requireIntegrity: true });
      await expect(
        load(c.meta, 'x-build', { scripts: [{ src, integrity: null }] }).envReady(c.environment),
      ).rejects.toThrow(/integrity required/);
    }
  });

  it('without requireIntegrity a script lacking integrity is not checked', async () => {
    const b = build({});
    expect(decodePstack(b.m.field).ri).toBeUndefined();
    await load(b.meta, 'x-build', { scripts: [null] }).envReady(b.environment, { inPlace: true });
    expect(b.environment['password']).toBe('p@ss');
  });

  it('requireIntegrity: decryptTreeAsync does not derive a key either', async () => {
    const b = build({ requireIntegrity: true });
    const env = { envName: 'uat', __pstack: b.environment['__pstack'] } as Record<string, unknown>;
    const r = load(b.meta, 'x-build', { scripts: [null] });
    await r.envReady(env);
    const other = { token: (b.environment['nested'] as Record<string, unknown>)['token'] };
    await expect(r.decryptTreeAsync(other)).rejects.toThrow(/integrity required/);
    expect(String(other.token)).toMatch(/^ENC2\(/);
  });

  it('rejects an ri flag other than 1', async () => {
    const b = build({});
    const p = decodePstack(b.m.field) as unknown as Record<string, unknown>;
    b.environment['__pstack'] = encodePstack({ ...p, ri: true } as never);
    await expect(load(b.meta).envReady(b.environment)).rejects.toThrow(/integrity flag/);
  });

  it('isHostAllowed', () => {
    const r = load(null);
    expect(r.isHostAllowed('a.com', ['a.com'], true)).toBe(true);
    expect(r.isHostAllowed('www.a.com', ['a.com'], false)).toBe(false);
    expect(r.isHostAllowed('www.a.com', ['a.com'], true)).toBe(true);
    expect(r.isHostAllowed('x.a.com', ['*.a.com'], true)).toBe(true);
    expect(r.isHostAllowed('a.com', ['*.a.com'], true)).toBe(false);
    expect(r.isHostAllowed('xa.com', ['*.a.com'], true)).toBe(false);
    expect(r.isHostAllowed('A.COM.', ['a.com'], true)).toBe(true);
    expect(r.isHostAllowed('a.com', ['a.com.'], true)).toBe(true);
    expect(r.isHostAllowed('x.a.com.', ['*.a.com.'], true)).toBe(true);
    expect(r.isHostAllowed('b.com', ['a.com'], true)).toBe(false);
    expect(r.isHostAllowed('', [], true)).toBe(false);
  });
});
