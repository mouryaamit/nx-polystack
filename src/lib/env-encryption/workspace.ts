import { readJson, Tree, updateJson } from '@nx/devkit';

import {
  defaultEnvEncryptionConfig,
  EnvEncryptionConfig,
  keysFromLegacy,
  LEGACY_KEYS_FILE,
  normalizeEnvEncryption,
} from './config';
import { DOT_ENV_LOCAL } from './placeholders';

/** The raw `pstack.envEncryption` block of nx.json (undefined when absent). */
export function readEnvEncryptionBlock(tree: Tree): unknown {
  if (!tree.exists('nx.json')) return undefined;
  return readJson(tree, 'nx.json')?.pstack?.envEncryption;
}

/** Writes a validated config into nx.json `pstack.envEncryption` (other pstack keys kept). */
export function writeEnvEncryptionBlock(tree: Tree, cfg: EnvEncryptionConfig): void {
  const block = normalizeEnvEncryption(cfg);
  updateJson(tree, 'nx.json', (json) => {
    json.pstack = { ...(json.pstack ?? {}), envEncryption: block };
    return json;
  });
}

/** The block a workspace gets: defaults, with keys from the legacy file when it exists. */
export function initialEnvEncryption(tree: Tree): EnvEncryptionConfig {
  const cfg = defaultEnvEncryptionConfig();
  if (tree.exists(LEGACY_KEYS_FILE)) {
    try {
      cfg.keys = keysFromLegacy(readJson(tree, LEGACY_KEYS_FILE));
    } catch {
      // A malformed legacy file keeps the default keys; the migration reports it.
    }
  }
  return cfg;
}

/** Adds `.env.local` to the root .gitignore (creates it when missing). Returns true when added. */
export function ignoreDotEnvLocal(tree: Tree): boolean {
  const text = tree.exists('.gitignore') ? tree.read('.gitignore', 'utf8') ?? '' : '';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(DOT_ENV_LOCAL) || lines.includes(`/${DOT_ENV_LOCAL}`)) return false;
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  tree.write('.gitignore', `${text}${sep}${DOT_ENV_LOCAL}\n`);
  return true;
}
