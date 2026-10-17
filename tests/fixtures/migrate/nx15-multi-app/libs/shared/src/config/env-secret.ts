// Runtime side of the build-time env encryption (test fixture).
import * as CryptoJS from 'crypto-js';

import { environment } from '../../../../environments/environment';

export type EncryptedEnvKey = string;

const ENC_OPEN = 'ENC(';
const isEncrypted = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith(ENC_OPEN) && v.endsWith(')');

export function getBuildMeta(): { commit?: string } | null {
  const content = document.querySelector('meta[name="x-build"]')?.getAttribute('content');
  return content ? JSON.parse(atob(content)) : null;
}

export function decryptEnvValue(value: string, commit = getBuildMeta()?.commit): string {
  if (!isEncrypted(value) || !commit) return value;
  return CryptoJS.AES.decrypt(value.slice(4, -1), commit).toString(CryptoJS.enc.Utf8) || value;
}

export function envSecret(key: EncryptedEnvKey): string {
  const raw = (environment as Record<string, unknown>)[key];
  return typeof raw === 'string' ? decryptEnvValue(raw) : '';
}

export function decryptEnvironment(env: Record<string, unknown> = environment as Record<string, unknown>): string[] {
  const done: string[] = [];
  for (const key of Object.keys(env)) {
    const raw = env[key];
    if (isEncrypted(raw)) {
      env[key] = decryptEnvValue(raw);
      done.push(key);
    }
  }
  return done;
}
