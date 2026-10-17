import { logger, Tree } from '@nx/devkit';

import { normalizeEnvEncryption } from '../../lib/env-encryption/config';
import {
  readEnvEncryptionBlock,
  writeEnvEncryptionBlock,
} from '../../lib/env-encryption/workspace';

/** v0.28.0: `pstack.envEncryption.keySource` becomes `keySources` (aes-gcm key factors). */
export default function envEncryptionKeySources(tree: Tree): void {
  const raw = readEnvEncryptionBlock(tree) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || !('keySource' in raw)) return;
  writeEnvEncryptionBlock(tree, normalizeEnvEncryption(raw));
  logger.info('env-encryption-key-sources: nx.json pstack.envEncryption.keySource → keySources.');
}
