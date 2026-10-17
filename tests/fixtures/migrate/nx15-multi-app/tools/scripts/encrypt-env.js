// Encrypts env values in place before the build (test fixture: shape only).
const CryptoJS = require('crypto-js');

/** Fields that stay plaintext in the bundle. */
const PUBLIC_ENV_KEYS = [
  'production',
  'envName',
  'appName',
  'product', // profile object
  'timeStamp',
];
const ENC_OPEN = 'ENC(';
const ENC_CLOSE = ')';

module.exports = {
  PUBLIC_ENV_KEYS,
  encrypt: (v, commit) => `${ENC_OPEN}${CryptoJS.AES.encrypt(v, commit).toString()}${ENC_CLOSE}`,
};
