import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CryptoJS = require('crypto-js');

export interface EncryptEnvOptions {
  /** Absolute path to the environment file (e.g. environment.ts). */
  filePath: string;
  /** Keys whose plaintext string values will be replaced with AES ciphertext. */
  keysToEncrypt: string[];
  /** AES encryption key (typically the git commit hash). */
  encryptionKey: string;
}

/**
 * Replaces `<key>: '<plaintext>'` patterns with `<key>: '<ciphertext>'` in place.
 * This is build-time obfuscation only — the commit hash is recoverable from the bundle.
 */
export function encryptEnvFile(opts: EncryptEnvOptions): void {
  const { filePath, keysToEncrypt, encryptionKey } = opts;
  if (!fs.existsSync(filePath)) {
    throw new Error(`encryptEnvFile: file not found: ${filePath}`);
  }
  if (keysToEncrypt.length === 0) return;

  let content = fs.readFileSync(filePath, 'utf8');

  for (const key of keysToEncrypt) {
    const re = new RegExp(`(${escapeRegex(key)}\\s*:\\s*['"])([^'"]+)(['"])`, 'g');
    content = content.replace(re, (_, pre, plaintext, post) => {
      const cipher = CryptoJS.AES.encrypt(plaintext, encryptionKey).toString();
      return `${pre}${cipher}${post}`;
    });
  }

  fs.writeFileSync(filePath, content, 'utf8');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
