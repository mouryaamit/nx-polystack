import { logger, readJson, Tree } from '@nx/devkit';

import { keysFromLegacy, LEGACY_KEYS_FILE } from '../../lib/env-encryption/config';
import {
  ignoreDotEnvLocal,
  initialEnvEncryption,
  readEnvEncryptionBlock,
  writeEnvEncryptionBlock,
} from '../../lib/env-encryption/workspace';

/**
 * v0.25.0: env encryption settings move into nx.json (`pstack.envEncryption`, mode "listed" with
 * the keys of tools/config/encrypt-keys.json, which is removed), and `.env.local` is ignored.
 * Builds encrypt the same fields as before.
 */
export default function envEncryptionConfig(tree: Tree): void {
  if (!tree.exists('nx.json')) return;
  const notes: string[] = [];
  if (readEnvEncryptionBlock(tree) === undefined) {
    const cfg = initialEnvEncryption(tree);
    if (tree.exists(LEGACY_KEYS_FILE)) {
      let valid = true;
      try {
        keysFromLegacy(readJson(tree, LEGACY_KEYS_FILE));
      } catch {
        valid = false;
      }
      if (valid) {
        tree.delete(LEGACY_KEYS_FILE);
        notes.push(`moved the keys of ${LEGACY_KEYS_FILE} into nx.json and removed it`);
      } else {
        notes.push(`${LEGACY_KEYS_FILE} could not be read; it was kept, default keys were written`);
      }
    }
    writeEnvEncryptionBlock(tree, cfg);
    notes.push('nx.json pstack.envEncryption written (mode "listed")');
  }
  if (ignoreDotEnvLocal(tree)) notes.push('.env.local added to .gitignore');
  if (notes.length > 0) logger.info(`env-encryption-config: ${notes.join('; ')}.`);
}
