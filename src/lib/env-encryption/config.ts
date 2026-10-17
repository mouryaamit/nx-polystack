import * as fs from 'fs';
import * as path from 'path';

import { isValidTimezone } from './stamp';

export type EncryptionMode = 'listed' | 'all';
export type EncryptionFormat = 'raw' | 'enc';

export const KEY_SOURCES = ['commit', 'salt', 'env', 'custom'] as const;
export type KeySource = (typeof KEY_SOURCES)[number];
export const CIPHERS = ['cryptojs', 'aes-gcm'];

export interface StampConfig {
  timeField?: string;
  branchField?: string;
  timezone?: string;
  /** Overrides the `z` token (e.g. "IST"). */
  timezoneLabel?: string;
  format?: string;
}

export interface EnvEncryptionConfig {
  mode: EncryptionMode;
  cipher: string;
  /** Key factors besides the internal per-build key (aes-gcm); at least one. */
  keySources: KeySource[];
  metaName: string;
  /** Listed mode: env project → keys; `default` for projects not listed. */
  keys: Record<string, string[]>;
  /** All mode: keys kept in plain text. */
  publicKeys: string[];
  stamp?: StampConfig;
  /** `raw`: ciphertext as is; `enc`: written as ENC(<ciphertext>). */
  format: EncryptionFormat;
  /** Files next to the env file (e.g. app.profile.ts) whose sensitive-looking fields are encrypted. */
  profileFiles: string[];
}

/**
 * Suggested keys (README examples). Not a default: before v0.25.0 a workspace without listed keys
 * encrypted nothing, so `keys.default` defaults to an empty list.
 */
export const SUGGESTED_KEYS = ['password', 'uname', 'key', 'iv'];
export const DEFAULT_PUBLIC_KEYS = ['production', 'envName', 'appName', 'timeStamp'];
export const DEFAULT_STAMP: Required<Omit<StampConfig, 'timezoneLabel'>> = {
  timeField: 'timeStamp',
  branchField: 'branch',
  timezone: 'UTC',
  format: 'DD MMM YYYY hh:mm:ss A z',
};
export const LEGACY_KEYS_FILE = 'tools/config/encrypt-keys.json';

export function defaultEnvEncryptionConfig(): EnvEncryptionConfig {
  return {
    mode: 'listed',
    cipher: 'cryptojs',
    keySources: ['commit'],
    metaName: 'x-build',
    format: 'raw',
    profileFiles: [],
    keys: { default: [] },
    publicKeys: [...DEFAULT_PUBLIC_KEYS],
    stamp: { ...DEFAULT_STAMP },
  };
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** Keys from the legacy encrypt-keys.json shape (`_default` + per project, `_doc` ignored). */
export function keysFromLegacy(json: Record<string, unknown>): Record<string, string[]> {
  const keys: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(json)) {
    const list = strings(v);
    if (!list || k === '_doc') continue;
    keys[k === '_default' ? 'default' : k] = list;
  }
  if (!keys['default']) keys['default'] = [];
  return keys;
}

/** A validated config from the raw `pstack.envEncryption` value; throws on invalid settings. */
export function normalizeEnvEncryption(raw: unknown): EnvEncryptionConfig {
  const base = defaultEnvEncryptionConfig();
  if (raw === undefined) return base;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('nx.json pstack.envEncryption must be an object.');
  }
  const r = raw as Record<string, unknown>;
  const cfg: EnvEncryptionConfig = {
    mode: (r['mode'] as EncryptionMode) ?? base.mode,
    cipher: (r['cipher'] as string) ?? base.cipher,
    keySources: base.keySources,
    metaName: (r['metaName'] as string) ?? base.metaName,
    format: (r['format'] as EncryptionFormat) ?? base.format,
    profileFiles: base.profileFiles,
    keys: base.keys,
    publicKeys: base.publicKeys,
    stamp:
      r['stamp'] === undefined ? undefined : { ...DEFAULT_STAMP, ...(r['stamp'] as StampConfig) },
  };
  if (!['listed', 'all'].includes(cfg.mode)) {
    throw new Error(`pstack.envEncryption.mode "${cfg.mode}" is not valid. Use listed or all.`);
  }
  if (!CIPHERS.includes(cfg.cipher)) {
    throw new Error(
      `pstack.envEncryption.cipher "${cfg.cipher}" is not valid. Use ${CIPHERS.join(' or ')}.`,
    );
  }
  if (r['keySource'] !== undefined && r['keySource'] !== 'commit') {
    throw new Error(
      'pstack.envEncryption.keySource is replaced by keySources (a list of commit, salt, env, ' +
        'custom); run "pstack update".',
    );
  }
  if (r['keySources'] !== undefined) {
    const list = strings(r['keySources']);
    const unknown = (list ?? []).filter((s) => !(KEY_SOURCES as readonly string[]).includes(s));
    if (!list || list.length === 0 || unknown.length > 0) {
      throw new Error(
        `pstack.envEncryption.keySources must list at least one of ${KEY_SOURCES.join(', ')}` +
          (unknown.length > 0 ? ` (unknown: ${unknown.join(', ')})` : '') +
          '.',
      );
    }
    cfg.keySources = KEY_SOURCES.filter((s) => list.includes(s));
  }
  if (typeof cfg.metaName !== 'string' || !/^[\w-]+$/.test(cfg.metaName)) {
    throw new Error('pstack.envEncryption.metaName must be a simple name such as x-build.');
  }
  if (r['keys'] !== undefined) {
    if (typeof r['keys'] !== 'object' || r['keys'] === null || Array.isArray(r['keys'])) {
      throw new Error('pstack.envEncryption.keys must map env projects to key lists.');
    }
    const keys: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(r['keys'] as Record<string, unknown>)) {
      const list = strings(v);
      if (!list) throw new Error(`pstack.envEncryption.keys.${k} must be a list of key names.`);
      keys[k] = list;
    }
    if (!keys['default']) keys['default'] = [];
    cfg.keys = keys;
  }
  if (!['raw', 'enc'].includes(cfg.format)) {
    throw new Error(`pstack.envEncryption.format "${cfg.format}" is not valid. Use raw or enc.`);
  }
  if (r['profileFiles'] !== undefined) {
    const list = strings(r['profileFiles']);
    if (
      !list ||
      list.some((f) => !/^[\w.-]+(\/[\w.-]+)*$/.test(f) || f.split('/').includes('..'))
    ) {
      throw new Error(
        'pstack.envEncryption.profileFiles must list files inside the env folder (e.g. app.profile.ts).',
      );
    }
    if (list.some((f) => /^environment(\.[\w-]+)?\.ts$/.test(f.split('/').pop() ?? ''))) {
      throw new Error(
        'pstack.envEncryption.profileFiles must not list env files (environment*.ts); they are ' +
          'encrypted already.',
      );
    }
    cfg.profileFiles = [...new Set(list)];
  }
  if (r['publicKeys'] !== undefined) {
    const list = strings(r['publicKeys']);
    if (!list) throw new Error('pstack.envEncryption.publicKeys must be a list of key names.');
    cfg.publicKeys = list;
  }
  if (r['stamp'] !== undefined) {
    if (typeof r['stamp'] !== 'object' || r['stamp'] === null || Array.isArray(r['stamp'])) {
      throw new Error('pstack.envEncryption.stamp must be an object.');
    }
    for (const [k, v] of Object.entries(r['stamp'] as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`pstack.envEncryption.stamp.${k} must be a string.`);
      }
    }
  }
  if (cfg.stamp?.timezone && !isValidTimezone(cfg.stamp.timezone)) {
    throw new Error(
      `pstack.envEncryption.stamp.timezone "${cfg.stamp.timezone}" is not a known time zone.`,
    );
  }
  return cfg;
}

export interface LoadedConfig {
  config: EnvEncryptionConfig;
  source: 'nx.json' | 'legacy' | 'default';
}

/** The workspace's settings: nx.json, else the legacy keys file, else defaults. */
export function loadEnvEncryptionConfig(repoRoot: string): LoadedConfig {
  const nxJsonPath = path.join(repoRoot, 'nx.json');
  if (fs.existsSync(nxJsonPath)) {
    const nx = JSON.parse(fs.readFileSync(nxJsonPath, 'utf8'));
    const raw = nx?.pstack?.envEncryption;
    if (raw !== undefined) return { config: normalizeEnvEncryption(raw), source: 'nx.json' };
  }
  const legacy = path.join(repoRoot, ...LEGACY_KEYS_FILE.split('/'));
  if (fs.existsSync(legacy)) {
    const cfg = defaultEnvEncryptionConfig();
    cfg.keys = keysFromLegacy(JSON.parse(fs.readFileSync(legacy, 'utf8')));
    cfg.stamp = undefined;
    return { config: cfg, source: 'legacy' };
  }
  const cfg = defaultEnvEncryptionConfig();
  cfg.stamp = undefined;
  return { config: cfg, source: 'default' };
}

/** Keys to encrypt for an env project in listed mode. */
export function listedKeys(cfg: EnvEncryptionConfig, envProject: string): string[] {
  return cfg.keys[envProject] ?? cfg.keys['default'] ?? [];
}
