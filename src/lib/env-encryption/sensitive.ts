/**
 * Whether a field name looks like it holds a secret (used for profile files, where only such
 * fields are encrypted). A name is split into words (camelCase, snake_case, kebab-case); it is
 * sensitive when a word is a credential, token or crypto-material word, or it is `<qualifier> key`
 * (apiKey, aesKey, clientKey). Names of things rather than the things themselves are not: a first
 * word that is a verb or flag prefix (getOtp, isPinSet) or a last word such as field, label,
 * route, url, code (otpField, loginRoute). A bare `key` (cacheKey, pincodeKey) is an identifier.
 */
const SENSITIVE_WORDS = new Set([
  // credentials
  'pass',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'passcode',
  'pin',
  'mpin',
  'tpin',
  'otp',
  'cvv',
  'secret',
  'secrets',
  'cred',
  'creds',
  'credential',
  'credentials',
  'uname',
  'username',
  'user',
  'userid',
  'login',
  'loginid',
  // tokens and auth material
  'token',
  'tokens',
  'jwt',
  'bearer',
  'authorization',
  'auth',
  'apikey',
  'cookie',
  'session',
  'sessionid',
  // crypto material
  'salt',
  'iv',
  'nonce',
  'hmac',
  'signature',
  'cipher',
  'ciphertext',
  'privatekey',
  'private',
  'cert',
  'certificate',
  'keystore',
  // client registration
  'clientsecret',
  'clientid',
]);

const KEY_QUALIFIERS = new Set([
  'api',
  'aes',
  'rsa',
  'des',
  'hmac',
  'jwt',
  'auth',
  'access',
  'app',
  'client',
  'master',
  'secret',
  'private',
  'public',
  'session',
  'encryption',
  'encrypt',
  'decryption',
  'decrypt',
  'crypto',
  'cipher',
  'signing',
  'sign',
  'license',
  'licence',
  'customer',
  'internal',
  'service',
  'merchant',
  'partner',
  'subscription',
]);

const NON_SECRET_FIRST_WORDS = new Set([
  'get',
  'send',
  'resend',
  'verify',
  'validate',
  'save',
  'fetch',
  'generate',
  'check',
  'update',
  'create',
  'delete',
  'submit',
  'call',
  'load',
  'is',
  'has',
  'show',
  'hide',
  'enable',
  'disable',
  'use',
  'allow',
  'on',
]);

const NON_SECRET_LAST_WORDS = new Set([
  'field',
  'fields',
  'label',
  'labels',
  'placeholder',
  'route',
  'routes',
  'url',
  'urls',
  'path',
  'endpoint',
  'api',
  'type',
  'types',
  'mode',
  'code',
  'codes',
  'length',
  'max',
  'min',
  'regex',
  'pattern',
  'message',
  'msg',
  'text',
  'title',
  'enabled',
  'required',
  'flag',
  'template',
]);

export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-$]+/)
    .filter(Boolean);
}

export function isSensitiveKey(name: string): boolean {
  const words = wordsOf(name);
  if (words.length === 0) return false;
  if (NON_SECRET_FIRST_WORDS.has(words[0])) return false;
  if (NON_SECRET_LAST_WORDS.has(words[words.length - 1])) return false;
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  if (words.some((w, i) => w === 'id' && words[i - 1] === 'client')) return true;
  return words.some((w, i) => w === 'key' && i > 0 && KEY_QUALIFIERS.has(words[i - 1]));
}
