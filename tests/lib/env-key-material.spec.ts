import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeEnvEncryption } from '../../src/lib/env-encryption/config';
import {
  combineShares,
  decodePstack,
  deriveKey,
  factorText,
  keyInfo,
} from '../../src/lib/env-encryption/gcm';
import {
  buildKeyMaterial,
  readKeyFactors,
  SALT_FILE,
} from '../../src/lib/env-encryption/key-material';

describe('key material', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads factors, creates the salt once, names missing variables', () => {
    const a = readKeyFactors(dir, ['commit', 'salt', 'env'], 'abc1234', { PSTACK_ENV_KEY: 'e' });
    expect(a.created).toBe(true);
    expect(fs.existsSync(path.join(dir, SALT_FILE))).toBe(true);
    const b = readKeyFactors(dir, ['salt'], 'abc1234', {});
    expect(b.created).toBe(false);
    expect(b.values.salt).toBe(a.values.salt);
    expect(() => readKeyFactors(dir, ['env'], 'c', {})).toThrow(/PSTACK_ENV_KEY/);
    expect(() => readKeyFactors(dir, ['custom'], 'c', {})).toThrow(/PSTACK_CUSTOM_KEY/);
    expect(() => readKeyFactors(dir, ['commit'], 'unknown', {})).toThrow(/commit/);
  });

  it('refuses an empty salt file and whitespace-only key variables without printing values', () => {
    const file = path.join(dir, SALT_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '  \n', 'utf8');
    expect(() => readKeyFactors(dir, ['salt'], 'c', {})).toThrow(/tools\/config\/env-salt.*empty/);
    expect(() => readKeyFactors(dir, ['env'], 'c', { PSTACK_ENV_KEY: ' \t ' })).toThrow(
      /PSTACK_ENV_KEY/,
    );
    expect(() => readKeyFactors(dir, ['custom'], 'c', { PSTACK_CUSTOM_KEY: '\n' })).toThrow(
      /PSTACK_CUSTOM_KEY/,
    );
  });

  it('keeps an existing salt file (never overwrites it)', () => {
    const file = path.join(dir, SALT_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'existing-salt\n', 'utf8');
    const r = readKeyFactors(dir, ['salt'], 'c', {});
    expect(r).toEqual({ values: { salt: 'existing-salt' }, created: false });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['env-salt']);
  });

  it('keeps the salt another build linked in first (race) and removes its temp file', () => {
    const file = path.join(dir, SALT_FILE);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const realFs: typeof fs = require('fs');
    const link = realFs.linkSync;
    const spy = jest.spyOn(realFs, 'linkSync').mockImplementation((from, to) => {
      fs.writeFileSync(file, 'other-build-salt\n', 'utf8');
      link(from, to);
    });
    try {
      const r = readKeyFactors(dir, ['salt'], 'c', {});
      expect(r).toEqual({ values: { salt: 'other-build-salt' }, created: false });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(path.dirname(file))).toEqual(['env-salt']);
  });

  it('checks every other factor before creating the salt', () => {
    expect(() => readKeyFactors(dir, ['salt', 'env'], 'c', {})).toThrow(/PSTACK_ENV_KEY/);
    expect(() => readKeyFactors(dir, ['salt', 'commit'], 'unknown', {})).toThrow(/commit/);
    expect(fs.existsSync(path.join(dir, SALT_FILE))).toBe(false);
  });

  it.each(['EPERM', 'ENOTSUP', 'EXDEV'])(
    'falls back to an exclusive write when hard links fail (%s)',
    (code) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const realFs: typeof fs = require('fs');
      const spy = jest.spyOn(realFs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      const file = path.join(dir, SALT_FILE);
      try {
        const r = readKeyFactors(dir, ['salt'], 'c', {});
        expect(r.created).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toBe(`${r.values.salt}\n`);
        expect(fs.readdirSync(path.dirname(file))).toEqual(['env-salt']);
        // Another build won the fallback write: its salt is kept.
        fs.writeFileSync(file, 'winner\n');
        realFs.rmSync(file);
        const orig = realFs.writeFileSync;
        const w = jest.spyOn(realFs, 'writeFileSync').mockImplementation((f, d, o) => {
          if (f === file) orig(file, 'winner\n');
          orig(f, d, o);
        });
        try {
          expect(readKeyFactors(dir, ['salt'], 'c', {})).toEqual({
            values: { salt: 'winner' },
            created: false,
          });
        } finally {
          w.mockRestore();
        }
        expect(fs.readdirSync(path.dirname(file))).toEqual(['env-salt']);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('creates a new salt complete in one step and leaves no temp file', () => {
    const r = readKeyFactors(dir, ['salt'], 'c', {});
    expect(r.created).toBe(true);
    const file = path.join(dir, SALT_FILE);
    expect(r.values.salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${r.values.salt}\n`);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['env-salt']);
  });

  it('builds shares, field and key that recombine to the same key', () => {
    const cfg = normalizeEnvEncryption({ cipher: 'aes-gcm', keySources: ['commit', 'custom'] });
    const now = new Date('2026-10-15T05:13:22.667Z');
    const m = buildKeyMaterial({
      repoRoot: dir,
      config: cfg,
      envProject: 'web',
      env: 'UAT',
      commit: 'abc1234',
      now,
      vars: { PSTACK_CUSTOM_KEY: 'server-secret' },
      keySplit: 'meta-bundle-asset',
      domains: ['A.com'],
      includeWww: true,
      onMismatch: 'block',
    });
    const p = decodePstack(m.field);
    expect(p).toMatchObject({
      v: 2,
      p: 'web',
      e: 'UAT',
      s: ['commit', 'custom'],
      f: { commit: 'abc1234' },
    });
    expect(JSON.stringify(p)).not.toContain('server-secret');
    expect(p.d).toEqual({ h: ['a.com'], w: true, m: 'block' });
    expect(p.a).toBe(m.parts.asset!.name);
    expect(m.parts.time).toBe(now.toISOString());
    const r = combineShares([
      Buffer.from(m.parts.share, 'base64url'),
      Buffer.from(p.b, 'base64url'),
      m.parts.asset!.bytes,
    ]);
    const again = deriveKey(
      r,
      factorText(['commit', 'custom'], { commit: 'abc1234', custom: 'server-secret' }),
      now.toISOString(),
      keyInfo('web', 'UAT'),
    );
    expect(again.equals(m.key)).toBe(true);
  });

  it('meta-bundle: two shares and no asset', () => {
    const cfg = normalizeEnvEncryption({ cipher: 'aes-gcm' });
    const m = buildKeyMaterial({
      repoRoot: dir,
      config: cfg,
      envProject: 'web',
      env: 'PROD',
      commit: 'c',
      now: new Date(),
      vars: {},
      keySplit: 'meta-bundle',
    });
    expect(m.parts.asset).toBeUndefined();
    expect(decodePstack(m.field).a).toBeUndefined();
    expect(decodePstack(m.field).d).toBeUndefined();
  });
});
