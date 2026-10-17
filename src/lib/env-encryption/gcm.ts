import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

import { KEY_SOURCES, KeySource } from './config';

/** aes-gcm values: `ENC2(<base64url iv>.<base64url ciphertext‖tag>)`. */
export const ENC2_OPEN = 'ENC2(';
export const ENC2_CLOSE = ')';
/** Hidden env field carrying the bundle share, bundle-side factors, asset name and domain lock. */
export const PSTACK_FIELD = '__pstack';

export type KeySplit = 'meta-bundle' | 'meta-bundle-asset';
export const KEY_SPLITS: KeySplit[] = ['meta-bundle', 'meta-bundle-asset'];

export const isEnc2 = (v: string): boolean => v.startsWith(ENC2_OPEN) && v.endsWith(ENC2_CLOSE);
export const b64u = (b: Buffer): string => b.toString('base64url');

/** XOR shares of `r`: every share alone is random; all of them XORed give `r`. */
export function xorShares(r: Buffer, count: 2 | 3): Buffer[] {
  const shares = Array.from({ length: count - 1 }, () => randomBytes(r.length));
  return [...shares, combineShares([r, ...shares])];
}

export function combineShares(shares: Buffer[]): Buffer {
  const out = Buffer.alloc(shares[0].length);
  if (shares.some((s) => s.length !== out.length))
    throw new Error('env encryption: key shares differ in length.');
  for (const s of shares) for (let i = 0; i < out.length; i++) out[i] ^= s[i];
  return out;
}

/** `<name>=<value>` lines of the selected factors, always in KEY_SOURCES order. */
export function factorText(
  sources: KeySource[],
  values: Partial<Record<KeySource, string>>,
): string {
  return KEY_SOURCES.filter((s) => sources.includes(s))
    .map((s) => `${s}=${values[s] ?? ''}`)
    .join('\n');
}

export function keyInfo(envProject: string, env: string): string {
  if (envProject.includes('|') || env.includes('|'))
    throw new Error(`env encryption: "|" is not allowed in the env project or env name.`);
  return `pstack-env-v2|${envProject}|${env}`;
}

/** HKDF-SHA256(r ‖ factors, salt = time, info) → 32-byte AES key (same bytes as Web Crypto). */
export function deriveKey(r: Buffer, factors: string, time: string, info: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.concat([r, Buffer.from(factors, 'utf8')]),
      Buffer.from(time, 'utf8'),
      Buffer.from(info, 'utf8'),
      32,
    ),
  );
}

/** AES-256-GCM, fresh 12-byte IV, AAD = the name of the property holding the value. */
export function encryptGcm(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
  return `${ENC2_OPEN}${b64u(iv)}.${b64u(ct)}${ENC2_CLOSE}`;
}

/** Inverse of encryptGcm (tests and tooling); throws on a malformed value or failed authentication. */
export function decryptGcm(key: Buffer, value: string, aad: string): string {
  const parts = isEnc2(value) ? value.slice(ENC2_OPEN.length, -ENC2_CLOSE.length).split('.') : [];
  const iv = Buffer.from(parts[0] ?? '', 'base64url');
  const bytes = Buffer.from(parts[1] ?? '', 'base64url');
  if (parts.length !== 2 || iv.length !== 12 || bytes.length < 16)
    throw new Error('env encryption: malformed ENC2 value');
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([d.update(bytes.subarray(0, bytes.length - 16)), d.final()]).toString(
    'utf8',
  );
}

export interface DomainLock {
  /** Normalised hosts (`example.com`, `*.example.com`). */
  h: string[];
  /** Listing `example.com` also allows `www.example.com`. */
  w: boolean;
  /** What a mismatch does. */
  m: 'block' | 'warn';
}

export interface PstackField {
  v: 2;
  /** Env project and env: part of the HKDF info. */
  p: string;
  e: string;
  /** Bundle share of the random key (base64url). */
  b: string;
  /** Selected key sources. */
  s: KeySource[];
  /** Bundle-side factor values (commit, salt, env); custom is never written. */
  f: Partial<Record<'commit' | 'salt' | 'env', string>>;
  /** Asset holding the third share (meta-bundle-asset). */
  a?: string;
  d?: DomainLock;
  /** 1: the runtime decrypts nothing while a script on the page has no integrity attribute. */
  ri?: 1;
}

export const encodePstack = (p: PstackField): string =>
  b64u(Buffer.from(JSON.stringify(p), 'utf8'));
export const decodePstack = (s: string): PstackField =>
  JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
