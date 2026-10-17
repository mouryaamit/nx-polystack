import { webcrypto } from 'crypto';

import {
  combineShares,
  decodePstack,
  decryptGcm,
  deriveKey,
  encodePstack,
  encryptGcm,
  factorText,
  isEnc2,
  keyInfo,
  xorShares,
} from '../../src/lib/env-encryption/gcm';

describe('gcm core', () => {
  const r = Buffer.alloc(32, 7);

  it('splits into XOR shares that recombine exactly and differ from the key', () => {
    for (const n of [2, 3] as const) {
      const shares = xorShares(r, n);
      expect(shares).toHaveLength(n);
      for (const s of shares) expect(s.equals(r)).toBe(false);
      expect(combineShares(shares).equals(r)).toBe(true);
      expect(combineShares(shares.slice(1)).equals(r)).toBe(false);
      const again = xorShares(r, n);
      for (let i = 0; i < n; i++) expect(again[i].equals(shares[i])).toBe(false);
    }
    const [a, b, c] = xorShares(r, 3);
    for (const pair of [
      [a, b],
      [a, c],
      [b, c],
    ])
      expect(combineShares(pair).equals(r)).toBe(false);
  });

  it('refuses to combine shares of different lengths', () => {
    expect(() => combineShares([Buffer.alloc(32), Buffer.alloc(16)])).toThrow(/length/);
  });

  it('refuses a key info part containing the separator', () => {
    expect(keyInfo('web', 'UAT')).toBe('pstack-env-v2|web|UAT');
    expect(() => keyInfo('we|b', 'UAT')).toThrow(/\|/);
    expect(() => keyInfo('web', 'U|AT')).toThrow(/\|/);
  });

  it('writes factors in a fixed order, only the selected ones', () => {
    expect(factorText(['salt', 'commit'], { commit: 'c1', salt: 's1', env: 'e1' })).toBe(
      'commit=c1\nsalt=s1',
    );
  });

  it('round-trips with the field name as AAD and fails on another name or a change', () => {
    const key = deriveKey(r, 'commit=c1', '2026-10-15T00:00:00.000Z', keyInfo('web', 'UAT'));
    const v = encryptGcm(key, 'p@ss', 'password');
    expect(isEnc2(v)).toBe(true);
    expect(decryptGcm(key, v, 'password')).toBe('p@ss');
    expect(() => decryptGcm(key, v, 'uname')).toThrow();
    // Flip a bit in the decoded bytes: editing the last base64url char can hit only padding bits.
    const [iv, ct] = v.slice(5, -1).split('.');
    const bytes = Buffer.from(ct, 'base64url');
    bytes[0] ^= 1;
    const tampered = `ENC2(${iv}.${bytes.toString('base64url')})`;
    expect(() => decryptGcm(key, tampered, 'password')).toThrow();
    expect(encryptGcm(key, 'p@ss', 'password')).not.toBe(v);
  });

  describe('decryptGcm on damaged values', () => {
    const key = deriveKey(r, '', '2026-10-15T00:00:00.000Z', keyInfo('web', 'UAT'));
    const v = encryptGcm(key, 'secret', 'apiKey');
    const [iv, ct] = v.slice(5, -1).split('.');
    const flip = (b64: string, index: number): string => {
      const bytes = Buffer.from(b64, 'base64url');
      bytes[index < 0 ? bytes.length + index : index] ^= 1;
      return bytes.toString('base64url');
    };

    it('fails authentication on a flipped tag byte', () => {
      expect(() => decryptGcm(key, `ENC2(${iv}.${flip(ct, -1)})`, 'apiKey')).toThrow();
    });

    it('fails authentication on a flipped IV byte', () => {
      expect(() => decryptGcm(key, `ENC2(${flip(iv, 0)}.${ct})`, 'apiKey')).toThrow();
    });

    const b = (n: number): string => Buffer.alloc(n, 1).toString('base64url');
    it.each([
      ['not ENC2', 'secret'],
      ['empty', 'ENC2()'],
      ['no dot', `ENC2(${iv}${ct})`],
      ['two dots', `ENC2(${iv}.${ct}.${ct})`],
      ['short iv', `ENC2(${b(11)}.${ct})`],
      ['long iv', `ENC2(${b(16)}.${ct})`],
      ['data shorter than the tag', `ENC2(${iv}.${b(15)})`],
    ])('rejects a malformed value (%s)', (_name, value) => {
      expect(() => decryptGcm(key, value, 'apiKey')).toThrow(
        'env encryption: malformed ENC2 value',
      );
    });
  });

  it('derives the same key as Web Crypto HKDF and decrypts with Web Crypto', async () => {
    const time = '2026-10-15T00:00:00.000Z';
    const info = keyInfo('web', 'UAT');
    const key = deriveKey(r, 'commit=c1', time, info);
    const v = encryptGcm(key, 'hello', 'apiKey');
    const enc = new TextEncoder();
    const base = await webcrypto.subtle.importKey(
      'raw',
      Buffer.concat([r, Buffer.from('commit=c1')]),
      'HKDF',
      false,
      ['deriveKey'],
    );
    const wk = await webcrypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(time), info: enc.encode(info) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const [iv, ct] = v.slice(5, -1).split('.');
    const plain = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: enc.encode('apiKey') },
      wk,
      Buffer.from(ct, 'base64url'),
    );
    expect(new TextDecoder().decode(plain)).toBe('hello');
  });

  it('encodes the __pstack field as base64url JSON', () => {
    const p = {
      v: 2 as const,
      p: 'web',
      e: 'UAT',
      b: 'AA',
      s: ['commit' as const],
      f: { commit: 'c1' },
    };
    const s = encodePstack(p);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePstack(s)).toEqual(p);
  });
});
