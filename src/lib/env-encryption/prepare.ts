import * as fs from 'fs';
import * as path from 'path';

import {
  backupEnvFile,
  LockOptions,
  lockEnvFile,
  markWritten,
  recoverEnvFile,
  restoreEnvFile,
} from './backup';
import {
  DEFAULT_STAMP,
  EnvEncryptionConfig,
  LEGACY_KEYS_FILE,
  loadEnvEncryptionConfig,
} from './config';
import {
  encryptEnvText,
  encryptProfileText,
  EnvSecret,
  SealedPair,
  setStringFields,
} from './encrypt';
import { appendEnvironmentField } from './env-file';
import { normalizeHosts } from './domains';
import { KEY_SPLITS, KeySplit, PSTACK_FIELD } from './gcm';
import { buildKeyMaterial, KeyParts, SALT_FILE } from './key-material';
import { DOT_ENV_LOCAL, fillPlaceholders, placeholderNames, placeholderVars } from './placeholders';
import { isSensitiveKey } from './sensitive';
import { formatStamp } from './stamp';
import { Secret } from '../hardening/leak-check';

export interface PrepareEnvOptions {
  repoRoot: string;
  envProject: string;
  /** DEV, UAT, PROD or a custom env. */
  env: string;
  envFile: string;
  commit: string;
  branch: string;
  /** For tests. */
  now?: Date;
  vars?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  /** Lock wait settings (tests). */
  lock?: Omit<LockOptions, 'onWait'>;
  /** aes-gcm: where the random key's shares go (default meta-bundle). */
  keySplit?: KeySplit;
  /** aes-gcm: hosts this build may run on (none: no lock). */
  domains?: string[];
  includeWww?: boolean;
  onMismatch?: 'block' | 'warn';
  /** aes-gcm: the runtime refuses to decrypt when a script has no integrity attribute (SRI). */
  requireIntegrity?: boolean;
}

export interface PreparedEnv {
  config: EnvEncryptionConfig;
  /** aes-gcm: meta share, time and optional asset for the executor. */
  keyParts?: KeyParts;
  /** Plaintexts encrypted in this build with their keys, for the leak check. Memory only. */
  secrets: Secret[];
  /** Restores the env file; a no-op when nothing was changed. */
  restore: () => void;
}

const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

/**
 * Release-build preparation of an env file. DEV: checks there are no placeholders, changes
 * nothing. Other envs: recovers a crashed build, backs the file up, fills `${VAR}` placeholders,
 * stamps the build time and branch, encrypts; `restore()` puts the original back.
 */
export function prepareEnvFile(opts: PrepareEnvOptions): PreparedEnv {
  const log = opts.log ?? ((m: string) => console.log(m));
  // One instant for the stamp, the aes-gcm key (HKDF salt) and the meta tag.
  const now = opts.now ?? new Date();
  const { config, source } = loadEnvEncryptionConfig(opts.repoRoot);
  if (source === 'legacy') {
    log(
      `⚠ env encryption: reading ${LEGACY_KEYS_FILE}; run "pstack update" to move the settings ` +
        'into nx.json (pstack.envEncryption).',
    );
  }
  const file = opts.envFile;
  const shown = rel(opts.repoRoot, file);
  const noop = { config, secrets: [], restore: () => undefined };
  const profilePaths = [
    ...new Set(config.profileFiles.map((p) => path.join(path.dirname(file), ...p.split('/')))),
  ].filter((p) => path.resolve(p) !== path.resolve(file));
  let profiles = profilePaths.filter((p) => fs.existsSync(p));

  if (opts.env === 'DEV') {
    for (const f of [file, ...profiles]) {
      if (!fs.existsSync(f)) continue;
      const names = placeholderNames(fs.readFileSync(f, 'utf8'));
      if (names.length > 0) {
        throw new Error(
          `env encryption: ${rel(opts.repoRoot, f)} has placeholders (${names
            .map((n) => `\${${n}}`)
            .join(', ')}). ` +
            'Dev env files must hold literal values because "nx serve" does not fill ' +
            'placeholders; keep them in the UAT/PROD files only.',
        );
      }
    }
    return noop;
  }
  // One release build at a time per file; others using the same files wait. Sorted, so two builds
  // never take the same locks in a different order.
  const files = [file, ...profilePaths].sort();
  const releases: (() => void)[] = [];
  let keyParts: KeyParts | undefined;
  let secrets: Secret[] = [];
  const releaseAll = () =>
    releases
      .splice(0)
      .reverse()
      .forEach((r) => r());
  try {
    for (const f of files) {
      releases.push(
        lockEnvFile(opts.repoRoot, f, {
          ...opts.lock,
          onWait: () =>
            log(
              `⏳ env encryption: waiting for another release build using ${rel(
                opts.repoRoot,
                f,
              )}…`,
            ),
        }),
      );
    }
    for (const f of files) {
      const recovered = recoverEnvFile(opts.repoRoot, f);
      const fs_ = rel(opts.repoRoot, f);
      if (recovered.restored) {
        log(`⚠ env encryption: restored ${fs_}, left encrypted by a build that did not finish.`);
      } else if (recovered.kept) {
        log(
          `⚠ env encryption: ${fs_} changed after a build that did not finish; kept it as it is ` +
            "and dropped that build's backup.",
        );
      }
    }
    // After recovery: a file a killed build left behind exists again.
    if (!fs.existsSync(file)) {
      releaseAll();
      return noop;
    }
    profiles = profilePaths.filter((p) => fs.existsSync(p));

    // Everything that can fail on the input is checked before any file is touched.
    const vars = opts.vars ?? placeholderVars(opts.repoRoot);
    const fill = (f: string) => {
      const filled = fillPlaceholders(fs.readFileSync(f, 'utf8'), vars);
      if (filled.missing.length > 0) {
        throw new Error(
          `env encryption: ${rel(opts.repoRoot, f)} needs ${filled.missing.join(', ')}; set ` +
            `${filled.missing.length > 1 ? 'them' : 'it'} in the environment or in ` +
            `${DOT_ENV_LOCAL} at the workspace root.`,
        );
      }
      return filled;
    };
    const filled = fill(file);
    const profileFills = profiles.map((p) => ({ p, pf: fill(p) }));
    let text = filled.text;
    const stamped: string[] = [];
    const values: Record<string, string> = {};
    if (config.stamp) {
      const s = { ...DEFAULT_STAMP, ...config.stamp };
      if (s.timeField) {
        values[s.timeField] = formatStamp(now, s.timezone, s.format, config.stamp.timezoneLabel);
      }
      if (s.branchField) values[s.branchField] = opts.branch;
      const r = setStringFields(text, values);
      text = r.text;
      stamped.push(...r.set);
    }
    let secret: EnvSecret = opts.commit;
    let pstackField: string | undefined;
    if (config.cipher === 'aes-gcm') {
      // Checked before the key material, which may create the salt file.
      const keySplit = opts.keySplit ?? 'meta-bundle';
      if (!KEY_SPLITS.includes(keySplit)) {
        throw new Error(
          `env encryption: keySplit "${keySplit}" is not one of ${KEY_SPLITS.join(', ')}.`,
        );
      }
      if (opts.domains) normalizeHosts(opts.domains);
      const material = buildKeyMaterial({
        repoRoot: opts.repoRoot,
        config,
        envProject: opts.envProject,
        env: opts.env,
        commit: opts.commit,
        now,
        vars,
        keySplit,
        domains: opts.domains,
        includeWww: opts.includeWww,
        onMismatch: opts.onMismatch,
        requireIntegrity: opts.requireIntegrity,
      });
      if (material.saltCreated) log(`🔑 env encryption: created ${SALT_FILE}; commit it.`);
      secret = material.key;
      keyParts = material.parts;
      pstackField = material.field;
    }
    const enc = encryptEnvText(text, config, opts.envProject, secret, shown);
    if (pstackField) enc.text = appendEnvironmentField(enc.text, PSTACK_FIELD, pstackField);
    if (enc.skipped.length > 0) {
      log(
        `⚠ env encryption: ${shown}: ${enc.skipped.join(', ')} not encrypted (the value is not a ` +
          'plain string).',
      );
    }
    // Stamp values (branch name, build time) are not secrets: a profile value equal to one (e.g.
    // `channel: 'develop'`) is not encrypted for it.
    const stampValues = new Set(stamped.map((k) => values[k]));
    const secretValues = new Set(enc.values.filter((v) => !stampValues.has(v)));
    const envPairs = enc.pairs.filter((p) => !stampValues.has(p.value));
    const profilePairs: SealedPair[] = [];
    const writes: { file: string; text: string; summary: string }[] = [
      {
        file,
        text: enc.text,
        summary: [
          filled.filled.length > 0 ? `filled ${filled.filled.join(', ')}` : '',
          stamped.length > 0 ? `stamped ${stamped.join(', ')}` : '',
          `encrypted ${enc.encrypted.length > 0 ? enc.encrypted.join(', ') : 'nothing'} (mode ${
            config.mode
          })`,
          config.cipher === 'aes-gcm' ? 'aes-gcm' : '',
        ]
          .filter(Boolean)
          .join('; '),
      },
    ];
    for (const { p, pf } of profileFills) {
      const pe = encryptProfileText(pf.text, config, secret, secretValues, rel(opts.repoRoot, p));
      profilePairs.push(...pe.pairs);
      if (pe.skipped.length > 0) {
        log(
          `⚠ env encryption: ${rel(opts.repoRoot, p)}: ${pe.skipped.join(
            ', ',
          )} look sensitive but ` + 'are not plain strings, so they were not encrypted.',
        );
      }
      writes.push({
        file: p,
        text: pe.text,
        summary: [
          pf.filled.length > 0 ? `filled ${pf.filled.join(', ')}` : '',
          `encrypted ${pe.encrypted.length > 0 ? pe.encrypted.join(', ') : 'nothing'}`,
        ]
          .filter(Boolean)
          .join('; '),
      });
    }

    secrets = buildSecrets(envPairs, profilePairs);
    const written: string[] = [];
    try {
      for (const w of writes) {
        backupEnvFile(opts.repoRoot, w.file);
        written.push(w.file);
        fs.writeFileSync(w.file, w.text, 'utf8');
        markWritten(opts.repoRoot, w.file, w.text);
      }
    } catch (err) {
      for (const f of written) restoreEnvFile(opts.repoRoot, f);
      throw err;
    }
    for (const w of writes) log(`🔒 ${rel(opts.repoRoot, w.file)}: ${w.summary}.`);
  } catch (err) {
    releaseAll();
    throw err;
  }
  return {
    config,
    keyParts,
    secrets,
    restore: () => {
      const failed: string[] = [];
      try {
        for (const f of files) {
          try {
            restoreEnvFile(opts.repoRoot, f);
          } catch (err) {
            failed.push((err as Error).message);
          }
        }
      } finally {
        releaseAll();
      }
      if (failed.length > 0) throw new Error(failed.join('\n'));
    },
  };
}

/**
 * Secrets for the leak check. C7: a profile value under a non-sensitive key was encrypted only
 * because it equals an env value, so the app's own configuration declares that value public;
 * every holder of it is marked.
 */
function buildSecrets(envPairs: SealedPair[], profilePairs: SealedPair[]): Secret[] {
  const publicValues = new Set(
    profilePairs.filter((p) => !isSensitiveKey(p.key)).map((p) => p.value),
  );
  return [...envPairs, ...profilePairs].map((p) => ({ ...p, public: publicValues.has(p.value) }));
}
