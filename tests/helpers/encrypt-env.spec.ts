import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { encryptEnvFile } from '../../src/lib/helpers/encrypt-env';

describe('encryptEnvFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-env-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces plaintext values for keys in the keysToEncrypt list', () => {
    const file = path.join(tmpDir, 'environment.ts');
    fs.writeFileSync(
      file,
      `export const environment = { apiKey: 'PLAINTEXT', other: 'visible' };\n`,
    );
    encryptEnvFile({ filePath: file, keysToEncrypt: ['apiKey'], encryptionKey: 'commit-hash' });
    const after = fs.readFileSync(file, 'utf8');
    expect(after).not.toContain("'PLAINTEXT'");
    expect(after).toContain("'visible'");
  });

  it('throws when filePath does not exist', () => {
    expect(() =>
      encryptEnvFile({ filePath: '/nonexistent', keysToEncrypt: ['x'], encryptionKey: 'k' }),
    ).toThrow(/not found/i);
  });

  it('is a no-op when keysToEncrypt is empty', () => {
    const file = path.join(tmpDir, 'environment.ts');
    const original = `export const environment = { x: 'y' };\n`;
    fs.writeFileSync(file, original);
    encryptEnvFile({ filePath: file, keysToEncrypt: [], encryptionKey: 'k' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('produces decryptable ciphertext (round-trip)', () => {
    const file = path.join(tmpDir, 'environment.ts');
    fs.writeFileSync(file, `export const environment = { secret: 'hello' };\n`);
    encryptEnvFile({ filePath: file, keysToEncrypt: ['secret'], encryptionKey: 'mykey' });
    const after = fs.readFileSync(file, 'utf8');
    const m = after.match(/secret:\s*'([^']+)'/);
    expect(m).toBeTruthy();
    const ciphertext = m![1];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const CryptoJS = require('crypto-js');
    const decrypted = CryptoJS.AES.decrypt(ciphertext, 'mykey').toString(CryptoJS.enc.Utf8);
    expect(decrypted).toBe('hello');
  });
});
