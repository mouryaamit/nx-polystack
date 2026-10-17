/* eslint-env browser */
/**
 * @mouryaamit/nx-polystack/runtime/env-secret
 *
 * Browser side of the release build's env encryption (nx.json pstack.envEncryption). The build
 * encrypts env values with CryptoJS AES, the passphrase being the build's commit, which the build
 * also writes into <meta name="x-build"> (base64 JSON). Values are `ENC(<ciphertext>)` (format
 * enc) or the bare ciphertext (format raw).
 *
 * Once, at startup (main.ts, before AppModule is imported or bootstrapped):
 *   import { environment } from '../../../environments/web/environment';
 *   import { envReadySync } from '@mouryaamit/nx-polystack/runtime/env-secret';
 * (ES module; a CommonJS copy is served to require() users such as Jest.)
 *   envReadySync(environment, { sync: ['uname'] });     // or { inPlace: true }
 * Then:
 *   envSecret('uname')                 // sync: decrypted at startup (sync) or on first call, cached
 *   await envSecretAsync('password')   // decrypted on every call, nothing kept
 *
 * Cipher aes-gcm (pstack.envEncryption.cipher): values are `ENC2(<iv>.<ciphertext>)`, decrypted
 * with Web Crypto under a per-build key split across the meta tag, the bundle (the hidden
 * `__pstack` env field) and optionally an asset. Web Crypto is async, so main.ts must
 *   await envReady(environment, { inPlace: true });   // + getKey for key source custom
 * before bootstrap; envReadySync leaves ENC2 values alone and envSecret throws on one. A domain
 * lock in __pstack can refuse (or warn) on hosts the build was not made for.
 *
 * Values that are not encrypted (nx serve, a plain build) are returned as they are. This keeps
 * values out of plain sight in the bundle; the key ships with the page, so it is not a
 * confidentiality guarantee: real secrets belong on a server.
 */
import AES from 'crypto-js/aes.js';
import Utf8 from 'crypto-js/enc-utf8.js';

const ENC_OPEN = 'ENC(';
const ENC_CLOSE = ')';
/** Base64 of "Salted__": the OpenSSL header CryptoJS writes for passphrase encryption. */
const RAW_PREFIX = 'U2FsdGVkX1';
const ENC2_OPEN = 'ENC2(';
/** Hidden env field written by aes-gcm builds (see src/lib/env-encryption/gcm.ts). */
const PSTACK_FIELD = '__pstack';
/** Order of the key factors in the HKDF input; same as KEY_SOURCES on the build side. */
const SOURCE_ORDER = ['commit', 'salt', 'env', 'custom'];
const SHARE_BYTES = 32;

const state = {
  env: undefined,
  metaName: 'x-build',
  cache: new Map(),
  warned: false,
  /** aes-gcm key of the registered environment (CryptoKey), set by envReady. */
  gcmKey: undefined,
  /** The domain lock refused this host. */
  blocked: false,
  /** __pstack and getKey of an envReady that had no ENC2 value: decryptTreeAsync derives later. */
  deferred: undefined,
  /** Top-level fields whose ENC2 value could not be decrypted (envSecret names them). */
  failed: new Set(),
  /** Parsed __pstack per environment object: envReady removes the field, a second call reuses it. */
  pstacks: new WeakMap(),
};

function warnOnce(message) {
  if (state.warned || typeof console === 'undefined') return;
  state.warned = true;
  console.warn(`[env-secret] ${message}`);
}

const isEnc2 = (v) => typeof v === 'string' && v.startsWith(ENC2_OPEN) && v.endsWith(ENC_CLOSE);
const utf8 = (s) => new TextEncoder().encode(s);

/** Bytes of base64url text, padded or not (Node writes it unpadded); throws when malformed. */
function fromB64u(s) {
  if (typeof s !== 'string' || s.length % 4 === 1 || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) {
    throw new Error('[env-secret] malformed base64url');
  }
  const bare = s.replace(/=+$/, '');
  const bin = atob(bare.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((bare.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The whole meta payload (with the aes-gcm key share), or null. */
function readMeta(metaName) {
  try {
    if (typeof document === 'undefined') return null;
    const meta = document.querySelector(`meta[name="${metaName || state.metaName}"]`);
    const content = meta && meta.getAttribute('content');
    const parsed = content ? JSON.parse(atob(content)) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The build info written into <meta name="x-build"> by the release build, or null. */
export function getBuildMeta(metaName) {
  const m = readMeta(metaName);
  if (!m) return null;
  // The aes-gcm key share is not build info.
  const rest = { ...m };
  delete rest.k;
  return rest;
}

/** True for `ENC(...)` and `ENC2(...)` values and bare CryptoJS passphrase ciphertext. */
export function isEncryptedValue(value) {
  if (typeof value !== 'string') return false;
  if (isEnc2(value)) return true;
  if (value.startsWith(ENC_OPEN) && value.endsWith(ENC_CLOSE)) return true;
  return value.startsWith(RAW_PREFIX) && /^[A-Za-z0-9+/]+=*$/.test(value) && value.length >= 44;
}

/**
 * Plaintext of an encrypted value; the value unchanged when it is not encrypted, when no commit
 * is available, or when it cannot be decrypted (one console warning, never the value).
 */
export function decryptEnvValue(value, commit) {
  if (!isEncryptedValue(value)) return value;
  // aes-gcm values need the async path (envReady); the sync path leaves them alone.
  if (isEnc2(value)) return value;
  const key = commit !== undefined ? commit : readMeta()?.commit;
  if (!key) {
    warnOnce(`encrypted env value but no <meta name="${state.metaName}"> commit found`);
    return value;
  }
  const cipher =
    value.startsWith(ENC_OPEN) && value.endsWith(ENC_CLOSE)
      ? value.slice(ENC_OPEN.length, -ENC_CLOSE.length)
      : value;
  try {
    const plain = AES.decrypt(cipher, String(key)).toString(Utf8);
    if (plain) return plain;
  } catch {
    // Falls through to the warning.
  }
  warnOnce('could not decrypt an env value (commit mismatch?)');
  return value;
}

const isPlainContainer = (v) => {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function decryptInPlace(env, commit, cacheTopLevel) {
  const done = [];
  const readOnly = [];
  const seen = new WeakSet();
  const walk = (node, prefix) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      if (!prefix && key === PSTACK_FIELD) continue;
      const raw = node[key];
      const at = prefix ? `${prefix}.${key}` : key;
      if (isEncryptedValue(raw)) {
        const plain = decryptEnvValue(raw, commit);
        if (plain !== raw) {
          if (cacheTopLevel && !prefix) state.cache.set(key, { raw, plain });
          try {
            node[key] = plain;
          } catch {
            // ES modules run in strict mode: a frozen or read-only object throws here.
          }
          if (node[key] === plain) done.push(at);
          else readOnly.push(at);
        }
      } else if (isPlainContainer(raw)) {
        walk(raw, at);
      }
    }
  };
  walk(env, '');
  if (readOnly.length > 0 && typeof console !== 'undefined') {
    console.warn(
      `[env-secret] read-only fields left encrypted in place: ${readOnly.join(', ')}` +
        (cacheTopLevel ? ' (envSecret() still returns top-level ones)' : ''),
    );
  }
  return done;
}

/**
 * Decrypts every encrypted value of an object tree in place (any object, not registered with
 * envReady); returns the dotted paths decrypted.
 */
export function decryptTree(obj, commit) {
  if (!obj || typeof obj !== 'object') return [];
  return decryptInPlace(obj, commit !== undefined ? commit : readMeta()?.commit, false);
}

/**
 * Validates and registers the environment. Another object starts over (cache, aes-gcm key,
 * blocked state, meta name unless given); the same object keeps them, so a later envReadySync
 * does not drop the key or the meta name.
 */
function register(environment, opts, name) {
  if (!environment || typeof environment !== 'object') {
    throw new Error(`[env-secret] ${name}(environment): pass the app environment object`);
  }
  if (state.env !== environment) {
    state.cache = new Map();
    state.gcmKey = undefined;
    state.blocked = false;
    state.failed = new Set();
    state.deferred = undefined;
  }
  // The same object registered again without metaName (e.g. a wrapper's envReadySync after
  // main.ts awaited envReady with a custom name) keeps the current meta name.
  if (opts.metaName) state.metaName = opts.metaName;
  else if (state.env !== environment) state.metaName = 'x-build';
  state.env = environment;
  state.warned = false;
}

/**
 * Registers the app's environment object and prepares it. Options:
 * - inPlace: decrypt every encrypted value of the environment (nested objects and arrays too)
 *   in place, so code reading environment.x gets plaintext;
 * - sync: top-level fields (or 'all') decrypted now into a private cache for envSecret();
 * - metaName: the meta tag with the build info (default x-build).
 * Returns the dotted paths decrypted. aes-gcm values (`ENC2(...)`) are left alone: use envReady.
 */
export function envReadySync(environment, options) {
  const opts = options || {};
  register(environment, opts, 'envReadySync');
  return readySync(environment, opts);
}

function readySync(environment, opts) {
  const commit = readMeta()?.commit;
  if (opts.inPlace) return decryptInPlace(environment, commit, true);
  const keys =
    opts.sync === 'all' ? Object.keys(environment) : Array.isArray(opts.sync) ? opts.sync : [];
  const done = [];
  for (const key of keys) {
    const raw = environment[key];
    if (typeof raw !== 'string') continue;
    const plain = decryptEnvValue(raw, commit);
    state.cache.set(key, { raw, plain });
    if (plain !== raw) done.push(key);
  }
  return done;
}

/** True when `host` is listed (`*.x` = any subdomain of x; `x` also allows www.x when www). */
export function isHostAllowed(host, hosts, www) {
  const norm = (v) =>
    String(v || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');
  const h = norm(host);
  if (!h) return false;
  return (hosts || []).some((listed) => {
    const entry = norm(listed);
    if (!entry) return false;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === entry || (!!www && h === `www.${entry}`);
  });
}

/** Whether this page may decrypt; never names the allowed hosts. */
function domainAllowed(lock) {
  if (!lock || typeof location === 'undefined') return true;
  const proto = String(location.protocol || '').toLowerCase();
  const host = String(location.hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (['capacitor:', 'ionic:'].includes(proto)) return true;
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return true;
  if (isHostAllowed(host, lock.h, lock.w)) return true;
  if (lock.m === 'warn') {
    if (typeof console !== 'undefined') {
      console.warn('[env-secret] this build is not meant for this host');
    }
    return true;
  }
  if (typeof console !== 'undefined') {
    console.error(
      '[env-secret] this build is not allowed on this host; env values were not decrypted',
    );
  }
  return false;
}

const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parses and checks a __pstack value; the error never quotes it. */
function parsePstack(raw) {
  const invalid = (why) => new Error(`[env-secret] invalid ${PSTACK_FIELD} field (${why})`);
  let p;
  try {
    p = JSON.parse(new TextDecoder().decode(fromB64u(raw)));
  } catch {
    throw invalid('not base64url JSON');
  }
  if (!isObj(p)) throw invalid('not an object');
  if (p.v !== 2) throw invalid('unknown version');
  if (!isStr(p.p) || !isStr(p.e) || p.p.includes('|') || p.e.includes('|')) {
    throw invalid('env project or env');
  }
  if (!isStr(p.b)) throw invalid('bundle share');
  if (!Array.isArray(p.s) || p.s.length === 0 || !p.s.every((s) => SOURCE_ORDER.includes(s))) {
    throw invalid('key sources');
  }
  if (p.f !== undefined && (!isObj(p.f) || !Object.values(p.f).every(isStr))) {
    throw invalid('key factors');
  }
  if (p.a !== undefined && (!isStr(p.a) || !/^[A-Za-z0-9._-]+$/.test(p.a))) {
    throw invalid('key asset');
  }
  if (
    p.d !== undefined &&
    (!isObj(p.d) ||
      !Array.isArray(p.d.h) ||
      !p.d.h.every(isStr) ||
      !['block', 'warn'].includes(p.d.m))
  ) {
    throw invalid('domain lock');
  }
  if (p.ri !== undefined && p.ri !== 1) throw invalid('integrity flag');
  return p;
}

/** The parsed __pstack of the environment, removed from it (it is reused on a second call). */
function takePstack(environment) {
  const raw = environment[PSTACK_FIELD];
  if (typeof raw !== 'string') return state.pstacks.get(environment);
  const p = parsePstack(raw);
  state.pstacks.set(environment, p);
  try {
    delete environment[PSTACK_FIELD];
  } catch {
    // Read-only object: the field stays; it holds no plaintext.
  }
  return p;
}

const keyError = (why) => new Error(`[env-secret] aes-gcm key: ${why}`);

/** One key share; every share is SHARE_BYTES long. */
function share(bytes, where) {
  if (bytes.length !== SHARE_BYTES) throw keyError(`the ${where} share has the wrong length`);
  return bytes;
}

/** The page's origin (location, else the document base URL); '' when neither is known. */
function pageOrigin() {
  try {
    if (typeof location !== 'undefined' && location && isStr(location.origin)) {
      return location.origin;
    }
    return new URL(document.baseURI).origin;
  } catch {
    return '';
  }
}

/**
 * SRI builds: every same-origin <script src> on the page (the files this build served) must carry
 * an integrity attribute, else a script was injected or its hash removed. Scripts from other
 * http(s) origins (tag managers, chat widgets) are left to the CSP allowlist; anything else
 * (blob:, data:, an unreadable src) is checked. A presence check (the browser verifies the
 * values); inline scripts are not covered. No document (SSR, worker): passes; a document that
 * cannot be queried fails.
 */
function scriptsHaveIntegrity() {
  if (typeof document === 'undefined' || !document) return true;
  if (typeof document.querySelectorAll !== 'function') return false;
  const origin = pageOrigin();
  for (const s of document.querySelectorAll('script[src]')) {
    let url;
    try {
      url = new URL(s.getAttribute('src') || '', document.baseURI);
    } catch {
      url = undefined;
    }
    const external =
      url && (url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== origin;
    if (external) continue;
    const value = s.getAttribute('integrity');
    if (!value || !value.trim()) return false;
  }
  return true;
}

async function deriveGcmKey(p, getKey) {
  // Checked before any key material is touched: no key, nothing decrypted.
  if (p.ri === 1 && !scriptsHaveIntegrity()) {
    throw new Error('[env-secret] integrity required: a script has no integrity attribute');
  }
  if (typeof crypto === 'undefined' || !crypto || !crypto.subtle) {
    throw new Error('[env-secret] aes-gcm needs Web Crypto (https or localhost)');
  }
  const meta = readMeta();
  if (!meta || !isStr(meta.k) || !isStr(meta.timestamp_utc)) {
    throw keyError(`no key share in <meta name="${state.metaName}">`);
  }
  const decode = (s, where) => {
    try {
      return share(fromB64u(s), where);
    } catch {
      throw keyError(`the ${where} share is malformed`);
    }
  };
  const shares = [decode(meta.k, 'meta'), decode(p.b, 'bundle')];
  if (p.a) {
    let bytes;
    try {
      const res = await fetch(new URL(`assets/${p.a}`, document.baseURI).toString(), {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('status');
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw keyError('the key asset could not be loaded');
    }
    if (bytes.length !== SHARE_BYTES) {
      // Usually index.html served for a missing file by a single-page-app fallback.
      throw keyError(
        'the key asset could not be loaded (got a different file — check the server serves ' +
          'assets/ before any SPA fallback)',
      );
    }
    shares.push(bytes);
  }
  const r = new Uint8Array(SHARE_BYTES);
  for (const s of shares) for (let i = 0; i < r.length; i++) r[i] ^= s[i];
  const values = { ...(p.f || {}) };
  delete values.custom;
  if (p.s.includes('custom')) {
    if (typeof getKey !== 'function') {
      throw new Error('[env-secret] key source custom: pass envReady(environment, { getKey })');
    }
    values.custom = String(await getKey());
  }
  const t = utf8(
    SOURCE_ORDER.filter((s) => p.s.includes(s))
      .map((s) => `${s}=${values[s] ?? ''}`)
      .join('\n'),
  );
  const ikm = new Uint8Array(r.length + t.length);
  ikm.set(r);
  ikm.set(t, r.length);
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8(meta.timestamp_utc),
      info: utf8(`pstack-env-v2|${p.p}|${p.e}`),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

/** Plaintext of an ENC2 value; throws (without the value) when malformed or not authentic. */
async function gcmDecrypt(key, value, holder) {
  const parts = value.slice(ENC2_OPEN.length, -ENC_CLOSE.length).split('.');
  if (parts.length !== 2) throw new Error('malformed');
  const iv = fromB64u(parts[0]);
  const data = fromB64u(parts[1]);
  if (iv.length !== 12 || data.length < 16) throw new Error('malformed');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(holder) },
    key,
    data,
  );
  return new TextDecoder().decode(plain);
}

/** Whether a tree holds an ENC2 value (the environment's own __pstack field skipped). */
function hasEnc2(root) {
  const seen = new WeakSet();
  const scan = (node, top) => {
    if (seen.has(node)) return false;
    seen.add(node);
    return Object.keys(node).some((k) => {
      if (top && k === PSTACK_FIELD) return false;
      const v = node[k];
      return isEnc2(v) || (isPlainContainer(v) && scan(v, false));
    });
  };
  return scan(root, true);
}

/**
 * Decrypts the encrypted values of a tree in place (ENC2 with `key`, cryptojs with `commit`).
 * AAD: the name of the property holding the value (for array items, the array's). `onTop` is
 * called for each top-level field of the registered environment (null for other trees).
 */
async function gcmWalk(root, key, commit, onTop) {
  const out = { done: [], readOnly: [], failed: [] };
  const seen = new WeakSet();
  const walk = async (node, prefix, holder) => {
    if (seen.has(node)) return;
    seen.add(node);
    const isArr = Array.isArray(node);
    for (const k of Object.keys(node)) {
      if (!prefix && onTop && k === PSTACK_FIELD) continue;
      const raw = node[k];
      const at = prefix ? `${prefix}.${k}` : k;
      const name = isArr ? holder : k;
      if (isEncryptedValue(raw)) {
        let plain = raw;
        if (!isEnc2(raw)) plain = decryptEnvValue(raw, commit);
        else {
          try {
            plain = await gcmDecrypt(key, raw, name);
          } catch {
            out.failed.push(at);
          }
        }
        if (!prefix && onTop) onTop(k, raw, plain);
        if (plain === raw) continue;
        try {
          node[k] = plain;
        } catch {
          // ES modules run in strict mode: a frozen or read-only object throws here.
        }
        if (node[k] === plain) out.done.push(at);
        else out.readOnly.push(at);
      } else if (isPlainContainer(raw)) {
        await walk(raw, at, name);
      }
    }
  };
  await walk(root, '', '');
  return out;
}

/** Console report of a walk: paths only, never values. */
function report(readOnly, failed, topLevelNote) {
  if (typeof console === 'undefined') return;
  if (readOnly.length > 0) {
    console.warn(
      `[env-secret] read-only fields left encrypted in place: ${readOnly.join(', ')}` +
        (topLevelNote ? ' (envSecret() still returns top-level ones)' : ''),
    );
  }
  if (failed.length > 0) {
    console.error(
      `[env-secret] could not decrypt (aes-gcm: malformed or not authentic): ${failed.join(', ')}`,
    );
  }
}

const notAllowed = () => new Error('[env-secret] this build is not allowed on this host');
const noKey = () => new Error('[env-secret] await envReady(environment) first');

/**
 * Registers the environment and decrypts it like envReadySync; aes-gcm builds (ENC2 values) need
 * this async call (Web Crypto) before bootstrap. Options as envReadySync, plus getKey (key
 * source custom). Values that fail authentication stay encrypted and are reported by path.
 */
export async function envReady(environment, options) {
  const opts = options || {};
  register(environment, opts, 'envReady');
  const p = takePstack(environment);
  if (!p) {
    if (hasEnc2(environment) && typeof console !== 'undefined') {
      console.error(
        `[env-secret] aes-gcm values but no ${PSTACK_FIELD} field (was the env file built by ` +
          'the release target?)',
      );
    }
    return readySync(environment, opts);
  }
  state.blocked = !domainAllowed(p.d);
  if (state.blocked) return [];
  if (!hasEnc2(environment)) {
    // No ENC2 value here: decryptTreeAsync derives the key if another tree needs it.
    if (!state.gcmKey) state.deferred = { env: environment, p, getKey: opts.getKey };
    return readySync(environment, opts);
  }
  state.deferred = undefined;
  const key = await deriveGcmKey(p, opts.getKey);
  // A concurrent call may have registered another object meanwhile: it keeps its own state.
  const owns = state.env === environment;
  if (owns) {
    state.gcmKey = key;
    state.failed = new Set();
  }
  const commit = readMeta()?.commit;
  const remember = (k, raw, plain) => {
    if (!owns) return;
    if (isEnc2(raw) && plain === raw) {
      state.failed.add(k);
      return;
    }
    state.failed.delete(k);
    state.cache.set(k, { raw, plain });
  };
  if (opts.inPlace) {
    const r = await gcmWalk(environment, key, commit, remember);
    report(r.readOnly, r.failed, true);
    return r.done;
  }
  const keys =
    opts.sync === 'all'
      ? Object.keys(environment).filter((k) => k !== PSTACK_FIELD)
      : Array.isArray(opts.sync)
      ? opts.sync
      : [];
  const done = [];
  const failed = [];
  for (const k of keys) {
    const raw = environment[k];
    if (typeof raw !== 'string') continue;
    let plain = raw;
    if (!isEnc2(raw)) plain = decryptEnvValue(raw, commit);
    else {
      try {
        plain = await gcmDecrypt(key, raw, k);
      } catch {
        failed.push(k);
      }
    }
    remember(k, raw, plain);
    if (plain !== raw) done.push(k);
  }
  report([], failed, false);
  return done;
}

/**
 * Decrypts every encrypted value (ENC2 and cryptojs) of any object tree in place with the key
 * registered by envReady; returns the dotted paths decrypted. Failures are reported by path.
 */
export async function decryptTreeAsync(obj) {
  if (state.blocked) throw notAllowed();
  let key = state.gcmKey;
  if (!key) {
    const d = state.deferred;
    if (!d || d.env !== state.env) throw noKey();
    key = await deriveGcmKey(d.p, d.getKey);
    // Same guard as envReady: keep the key only while that environment is still registered.
    if (state.env === d.env && state.deferred === d) {
      state.gcmKey = key;
      state.deferred = undefined;
    }
  }
  if (!obj || typeof obj !== 'object') return [];
  const r = await gcmWalk(obj, key, readMeta()?.commit, null);
  report(r.readOnly, r.failed, false);
  return r.done;
}

function rawValue(key) {
  if (!state.env) {
    throw new Error('[env-secret] call envReady(environment) or envReadySync(environment) first');
  }
  const raw = state.env[key];
  return typeof raw === 'string' ? raw : undefined;
}

/** Plaintext of a top-level env field ('' when it is not a string); cached after the first call. */
export function envSecret(key) {
  const raw = rawValue(key);
  const hit = state.cache.get(key);
  // A cached value stays valid while the field holds the value it was read from (or its
  // plaintext, after an in-place decrypt).
  if (hit && (hit.raw === raw || hit.plain === raw)) return hit.plain;
  if (isEnc2(raw)) {
    if (state.blocked) throw notAllowed();
    if (state.failed.has(key)) throw new Error(`[env-secret] could not decrypt ${key}`);
    throw new Error(
      `[env-secret] ${key} uses aes-gcm; await envReady(environment) before bootstrap`,
    );
  }
  const plain = raw === undefined ? '' : decryptEnvValue(raw);
  state.cache.set(key, { raw, plain });
  return plain;
}

/** Plaintext of a top-level env field, decrypted on every call; nothing is kept. */
export async function envSecretAsync(key) {
  const raw = rawValue(key);
  if (raw === undefined) return '';
  if (!isEnc2(raw)) return decryptEnvValue(raw);
  if (state.blocked) throw notAllowed();
  if (!state.gcmKey) throw noKey();
  try {
    return await gcmDecrypt(state.gcmKey, raw, key);
  } catch {
    throw new Error(`[env-secret] could not decrypt ${key} (aes-gcm: malformed or not authentic)`);
  }
}
