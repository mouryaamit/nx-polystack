import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { EnvEncryptionConfig, KeySource } from './config';
import { normalizeHosts } from './domains';
import {
  b64u,
  deriveKey,
  encodePstack,
  factorText,
  keyInfo,
  KeySplit,
  PstackField,
  xorShares,
} from './gcm';

export const SALT_FILE = 'tools/config/env-salt';
export const ENV_KEY_VAR = 'PSTACK_ENV_KEY';
export const CUSTOM_KEY_VAR = 'PSTACK_CUSTOM_KEY';

type Vars = Record<string, string | undefined>;

/** A new random salt (32 bytes, base64url) for the salt file. */
export function newSalt(): string {
  return `${b64u(randomBytes(32))}\n`;
}

/**
 * Values of the selected key sources. Every other source is checked first and the salt file is
 * created (when missing) last, so a failing check creates nothing. Never logs values.
 */
export function readKeyFactors(
  repoRoot: string,
  sources: KeySource[],
  commit: string,
  vars: Vars,
): { values: Partial<Record<KeySource, string>>; created: boolean } {
  const values: Partial<Record<KeySource, string>> = {};
  let created = false;
  const need = (name: string, source: KeySource): string => {
    const v = vars[name];
    if (!v || !v.trim()) {
      throw new Error(
        `env encryption: key source ${source} needs a non-empty ${name} (environment or .env.local).`,
      );
    }
    return v;
  };
  for (const s of sources) {
    if (s === 'salt') continue;
    if (s === 'commit') {
      if (!commit || commit === 'unknown') {
        throw new Error('env encryption: key source commit needs the build commit (git or CI).');
      }
      values.commit = commit;
    } else if (s === 'env') {
      values.env = need(ENV_KEY_VAR, s);
    } else {
      values.custom = need(CUSTOM_KEY_VAR, s);
    }
  }
  if (sources.includes('salt')) {
    const file = path.join(repoRoot, ...SALT_FILE.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) created = createSaltFile(file);
    const salt = fs.readFileSync(file, 'utf8').trim();
    if (!salt) {
      throw new Error(
        `env encryption: key source salt: ${SALT_FILE} is empty (delete it to create a new salt).`,
      );
    }
    values.salt = salt;
  }
  return { values, created };
}

/** Link errors of file systems without hard links: fall back to an exclusive write. */
const NO_HARD_LINKS = ['EPERM', 'ENOTSUP', 'EXDEV'];

/**
 * Writes a new salt to a temp file in the same folder, then hard-links it into place: the link
 * either fails (another build created the salt first; its file is kept) or puts a complete file
 * there, so a parallel build never reads a half-written salt. Without hard links, the salt is
 * written with 'wx' (another build may then briefly see a partly written file).
 * Returns whether this build created the salt.
 */
function createSaltFile(file: string): boolean {
  const salt = newSalt();
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const lost = (e: unknown) => {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  };
  try {
    fs.writeFileSync(temp, salt, { encoding: 'utf8', flag: 'wx' });
    try {
      fs.linkSync(temp, file);
      return true;
    } catch (e) {
      if (!NO_HARD_LINKS.includes((e as NodeJS.ErrnoException).code ?? '')) return lost(e);
    }
    try {
      fs.writeFileSync(file, salt, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      return lost(e);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export interface KeyParts {
  /** Meta share (base64url). */
  share: string;
  /** Build time, ISO-8601 UTC: HKDF salt and the meta `timestamp_utc`. */
  time: string;
  asset?: { name: string; bytes: Buffer };
}

export interface KeyMaterialOptions {
  repoRoot: string;
  config: EnvEncryptionConfig;
  envProject: string;
  env: string;
  commit: string;
  now: Date;
  vars: Vars;
  keySplit: KeySplit;
  domains?: string[];
  includeWww?: boolean;
  onMismatch?: 'block' | 'warn';
  /** SRI build: the runtime refuses to decrypt when a script has no integrity attribute. */
  requireIntegrity?: boolean;
}

export interface KeyMaterial {
  key: Buffer;
  /** Encoded `__pstack` value. */
  field: string;
  parts: KeyParts;
  saltCreated: boolean;
}

/** A fresh per-build key: random R split into shares, factors, HKDF. */
export function buildKeyMaterial(o: KeyMaterialOptions): KeyMaterial {
  const sources = o.config.keySources;
  const factors = readKeyFactors(o.repoRoot, sources, o.commit, o.vars);
  const time = o.now.toISOString();
  const r = randomBytes(32);
  const shares = xorShares(r, o.keySplit === 'meta-bundle-asset' ? 3 : 2);
  const key = deriveKey(r, factorText(sources, factors.values), time, keyInfo(o.envProject, o.env));
  const asset =
    shares.length === 3
      ? {
          name: `pstack-k.${createHash('sha256').update(shares[2]).digest('hex').slice(0, 8)}.bin`,
          bytes: shares[2],
        }
      : undefined;
  // The custom factor is server-side only: never written to the bundle.
  const bundleFactors: PstackField['f'] = {};
  for (const s of ['commit', 'salt', 'env'] as const) {
    if (factors.values[s] !== undefined) bundleFactors[s] = factors.values[s];
  }
  const field: PstackField = {
    v: 2,
    p: o.envProject,
    e: o.env,
    b: b64u(shares[1]),
    s: sources,
    f: bundleFactors,
    ...(asset ? { a: asset.name } : {}),
    ...(o.domains && o.domains.length > 0
      ? {
          d: {
            h: normalizeHosts(o.domains),
            w: o.includeWww ?? true,
            m: o.onMismatch ?? 'block',
          },
        }
      : {}),
    ...(o.requireIntegrity ? { ri: 1 as const } : {}),
  };
  return {
    key,
    field: encodePstack(field),
    parts: { share: b64u(shares[0]), time, ...(asset ? { asset } : {}) },
    saltCreated: factors.created,
  };
}
