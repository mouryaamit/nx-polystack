import { EnvEncryptionConfig, listedKeys } from './config';
import {
  closingBracket,
  environmentFields,
  environmentObjectStart,
  isCodeAt,
  nextCode,
  quotedStrings,
  ScannedString,
  scanEnvironment,
  scanStructure,
  stripComments,
  Structure,
  unescapeString,
} from './env-file';
import { encryptGcm, isEnc2 } from './gcm';
import { isSensitiveKey } from './sensitive';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CryptoJS = require('crypto-js');

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** CryptoJS AES with a passphrase (OpenSSL-compatible base64), the format apps decrypt today. */
export const encryptValue = (plain: string, passphrase: string): string =>
  CryptoJS.AES.encrypt(plain, passphrase).toString();

export interface EncryptResult {
  text: string;
  encrypted: string[];
  /** Listed keys that were left as they are (their values are not plain strings). */
  skipped: string[];
  /** The plaintexts that were encrypted (for profile files; never printed). */
  values: string[];
  /** Each encrypted plaintext with the key holding it (for the leak check; never printed). */
  pairs: SealedPair[];
}

export interface SealedPair {
  key: string;
  value: string;
}

const plaintexts = (pairs: SealedPair[]) => pairs.map((p) => p.value);

export const ENC_OPEN = 'ENC(';
export const ENC_CLOSE = ')';
const isEncMarked = (v: string) => (v.startsWith(ENC_OPEN) && v.endsWith(ENC_CLOSE)) || isEnc2(v);

/** Whether committed values already in ENC(...)/ENC2(...) form are refused. */
const refusesCommitted = (cfg: EnvEncryptionConfig) =>
  cfg.format === 'enc' || cfg.cipher === 'aes-gcm';

/** Committed values already in ENC(...)/ENC2(...) form are ambiguous: refuse them. */
function refuseCommittedEnc(cfg: EnvEncryptionConfig, file: string, keys: string[]): void {
  if (refusesCommitted(cfg) && keys.length > 0) {
    fail(
      file,
      keys,
      'values already in ENC(...)/ENC2(...) form; commit the plaintext value instead',
    );
  }
}

/** The key: the commit passphrase (cryptojs) or the derived 32-byte key (aes-gcm). */
export type EnvSecret = string | Buffer;

/** Encrypts a value (AAD = the name of the property holding it) and wraps it as configured. */
function sealer(cfg: EnvEncryptionConfig, secret: EnvSecret, pairs: SealedPair[]) {
  // A programming error, not a configuration one: the caller passed the other cipher's key.
  if (cfg.cipher === 'aes-gcm' && !Buffer.isBuffer(secret)) {
    throw new Error('env encryption: aes-gcm needs the derived 32-byte key, not a passphrase.');
  }
  if (cfg.cipher !== 'aes-gcm' && Buffer.isBuffer(secret)) {
    throw new Error('env encryption: cryptojs needs a passphrase, not a derived key.');
  }
  return (plain: string, holder: string): string => {
    pairs.push({ key: holder, value: plain });
    if (Buffer.isBuffer(secret)) return encryptGcm(secret, plain, holder);
    const c = encryptValue(plain, secret);
    return cfg.format === 'enc' ? `${ENC_OPEN}${c}${ENC_CLOSE}` : c;
  };
}

/** A `key:` in object-key position (after `{` or `,`): the whole identifier, non-ASCII included. */
const HOLDER = /(?:^|[{,])\s*([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*:\s*$/;
/** A quoted `'key':` in object-key position: its content (escapes kept). */
const QUOTED_HOLDER = /(?:^|[{,])\s*(['"])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1\s*:\s*$/;

/**
 * The name of the property holding a value that follows `before` (what `Object.keys` gives at
 * runtime: a quoted key unescaped), or undefined when the value is not a property value.
 */
function holderOf(before: string): string | undefined {
  const code = stripComments(before);
  const quoted = QUOTED_HOLDER.exec(code);
  if (quoted) return unescapeString(quoted[2]);
  return HOLDER.exec(code)?.[1];
}

/**
 * Fields kept plain in `all` mode: the publicKeys. Stamp fields are not exempt: they are encrypted
 * after stamping unless listed there (the default list has `timeStamp` but not the branch).
 */
export function plainKeys(cfg: EnvEncryptionConfig): Set<string> {
  return new Set(cfg.publicKeys);
}

/** Never prints values: they may be secrets (placeholders are already filled). */
function fail(file: string, what: string[], why: string): never {
  throw new Error(`env encryption (${file}): ${why}: ${what.join(', ')}.`);
}

/**
 * Encrypts an env file's text by the workspace settings. `listed`: every `key: '<literal>'` of a
 * listed key at any depth (the match used before v0.25.0); listed top-level keys with other
 * values are left alone and reported in `skipped`. `all`: every top-level string literal except
 * plain keys; anything the scanner cannot read as a field, and non-literal values of non-plain
 * keys, fail the build.
 */
export function encryptEnvText(
  text: string,
  cfg: EnvEncryptionConfig,
  envProject: string,
  secret: EnvSecret,
  file = 'environment file',
): EncryptResult {
  const scan = scanEnvironment(text);
  const fields = scan.fields;
  const encrypted: string[] = [];
  const pairs: SealedPair[] = [];
  const seal = sealer(cfg, secret, pairs);
  if (cfg.mode === 'listed') {
    const keys = listedKeys(cfg, envProject);
    const skipped = fields
      .filter((f) => keys.includes(f.key) && f.kind === 'expression')
      .map((f) => f.key);
    // Same fields as the regex used before v0.25.0 (`<key>\s*:\s*'<value>'` anywhere in the file,
    // key not anchored to a word start), but the string is read by the scanner, so quotes and
    // escapes inside the value are handled and the value is encrypted as the app would see it.
    // aes-gcm also matches quoted keys (`'my-Key': …`); cryptojs keeps the match above unchanged.
    const quote = cfg.cipher === 'aes-gcm' ? `['"]?` : '';
    const keyRes = keys.map((k) => ({
      key: k,
      re: new RegExp(`${escapeRegex(k)}${quote}\\s*:\\s*$`),
    }));
    let out = '';
    let last = 0;
    const committed: string[] = [];
    // aes-gcm values are decrypted from the environment object only: hits elsewhere would stay
    // encrypted in the app, so they fail the build.
    const envOpen = environmentObjectStart(text);
    const envClose = envOpen < 0 ? -1 : closingBracket(text, envOpen);
    const outside: string[] = [];
    const unheld: string[] = [];
    for (const str of quotedStrings(text)) {
      if (str.content === '') continue;
      const before = text.slice(Math.max(0, str.start - 200), str.start);
      const hit = keyRes.find((k) => k.re.test(before));
      if (!hit) continue;
      if (cfg.cipher === 'aes-gcm' && !(str.start > envOpen && str.start < envClose)) {
        outside.push(hit.key);
        continue;
      }
      // aes-gcm binds each value to the property holding it; cryptojs ignores the holder.
      const holder = holderOf(before);
      if (cfg.cipher === 'aes-gcm' && holder === undefined) {
        unheld.push(hit.key);
        continue;
      }
      if (isEncMarked(unescapeString(str.content))) committed.push(hit.key);
      out +=
        text.slice(last, str.start) +
        str.quote +
        seal(unescapeString(str.content), holder ?? hit.key) +
        str.quote;
      last = str.end;
      encrypted.push(hit.key);
    }
    out += text.slice(last);
    if (outside.length > 0) {
      fail(
        file,
        [...new Set(outside)],
        'listed key outside the environment object; aes-gcm only decrypts environment fields — move it into environment or unlist it',
      );
    }
    if (unheld.length > 0) {
      fail(
        file,
        [...new Set(unheld)],
        'listed key matched a value with no property name holding it (aes-gcm binds each value to its property name) — write it as `name: value` or unlist it',
      );
    }
    refuseCommittedEnc(cfg, file, [...new Set(committed)]);
    return {
      text: out,
      encrypted: [...new Set(encrypted)],
      skipped,
      values: plaintexts(pairs),
      pairs,
    };
  }
  if (!scan.found) {
    fail(file, ['export const environment = { … }'], 'mode "all" found no environment object');
  }
  if (scan.unkeyed.length > 0) {
    fail(
      file,
      scan.unkeyed,
      'mode "all" needs every field written as `key: value` (no shorthand, spread or computed keys)',
    );
  }
  const plain = plainKeys(cfg);
  // Stamp fields the build cannot fill (not a string literal) are left as they are (not encrypted).
  const stampKeys = new Set([cfg.stamp?.timeField, cfg.stamp?.branchField].filter(Boolean));
  const bad = fields
    .filter((f) => f.kind === 'expression' && !plain.has(f.key) && !stampKeys.has(f.key))
    .map((f) => f.key);
  if (bad.length > 0) {
    fail(
      file,
      bad,
      'in mode "all" every non-public field must be a literal (make it one or add it to publicKeys)',
    );
  }
  refuseCommittedEnc(
    cfg,
    file,
    fields
      .filter((f) => f.kind === 'string' && f.text && isEncMarked(unescapeString(f.text)))
      .map((f) => f.key),
  );
  let out = '';
  let last = 0;
  for (const f of fields) {
    if (f.kind !== 'string' || plain.has(f.key) || f.text === undefined || f.text === '') continue;
    const q = text[f.start] === '`' ? "'" : text[f.start];
    out += text.slice(last, f.start) + q + seal(unescapeString(f.text), f.key) + q;
    last = f.end;
    encrypted.push(f.key);
  }
  out += text.slice(last);
  return { text: out, encrypted, skipped: [], values: plaintexts(pairs), pairs };
}

/** `key:` at the end of `before`, in object-key position (after `{` or `,`). */
const KEY_POSITION = /(?:^|[{,])\s*(['"]?)([A-Za-z_$][\w$-]*)\1\s*:\s*$/;

/**
 * Where profile strings are object property values or items of arrays that are property values,
 * in object literals only (not type literals, interfaces, parameters, calls, index access or
 * ternaries).
 */
class ProfileShape {
  private readonly literal = new Map<number, boolean>();
  private readonly structure: Structure;

  constructor(private readonly text: string) {
    this.structure = scanStructure(text);
  }

  get strings(): ScannedString[] {
    return this.structure.strings;
  }

  get brackets(): Structure['brackets'] {
    return this.structure.brackets;
  }

  /** The key when `index` follows `key:` in object-key position, else undefined. */
  keyBefore(index: number): string | undefined {
    const before = stripComments(this.text.slice(Math.max(0, index - 300), index));
    return KEY_POSITION.exec(before)?.[2];
  }

  /** Whether the `{` at `open` starts an object literal (not a type, interface or block). */
  isObjectLiteral(open: number): boolean {
    const cached = this.literal.get(open);
    if (cached !== undefined) return cached;
    const b = this.structure.brackets.get(open);
    let result = false;
    if (b?.char === '{') {
      const before = stripComments(this.text.slice(Math.max(0, open - 300), open)).trimEnd();
      const prev = before.slice(-1);
      if (prev === '=') {
        result = !/\btype\s+[\w$]+(\s*<[^>]*>)?\s*=$/.test(before) && !/[=!<>]=$/.test(before);
      } else if (prev === ':') {
        result =
          this.keyBefore(open) !== undefined && b.parent >= 0 && this.isObjectLiteral(b.parent);
      } else if (prev === '[' || prev === ',') {
        const parent = b.parent >= 0 ? this.structure.brackets.get(b.parent) : undefined;
        result =
          (parent?.char === '[' && this.isValueArray(b.parent)) ||
          (parent?.char === '(' && this.isCallArgs(b.parent));
      } else if (prev === '(') {
        // createProfile({ … }), Object.freeze({ … }), () => ({ … })
        result = this.isCallArgs(b.parent) || /=>\s*\($/.test(before);
      } else {
        result = /\b(?:return|default)$/.test(before);
      }
    }
    this.literal.set(open, result);
    return result;
  }

  /** Whether the `(` at `open` holds call arguments (not parameters of a declaration). */
  isCallArgs(open: number): boolean {
    const b = open >= 0 ? this.structure.brackets.get(open) : undefined;
    if (b?.char !== '(') return false;
    const before = stripComments(this.text.slice(Math.max(0, open - 300), open)).trimEnd();
    if (/\bfunction\s*[\w$]*\s*(<[^>]*>)?$/.test(before)) return false;
    return /[\w$)\]]$/.test(before) && !/\b(if|for|while|switch|catch|with)$/.test(before);
  }

  /** Whether the `[` at `open` is an array value: assigned, exported, returned, a property or an argument. */
  isValueArray(open: number): boolean {
    const b = this.structure.brackets.get(open);
    if (b?.char !== '[') return false;
    if (this.isPropertyArray(open)) return true;
    const before = stripComments(this.text.slice(Math.max(0, open - 300), open)).trimEnd();
    const prev = before.slice(-1);
    if (prev === '=')
      return !/[=!<>]=$/.test(before) && !/\btype\s+[\w$]+(\s*<[^>]*>)?\s*=$/.test(before);
    if (prev === '(' || prev === ',') {
      const parent = b.parent >= 0 ? this.structure.brackets.get(b.parent) : undefined;
      if (parent?.char === '(') return this.isCallArgs(b.parent);
      if (parent?.char === '[') return this.isValueArray(b.parent);
      return false;
    }
    return /\b(?:return|default)$/.test(before) || /=>$/.test(before);
  }

  /** Whether the `[` at `open` is an array that is a property value of an object literal. */
  isPropertyArray(open: number): boolean {
    const b = this.structure.brackets.get(open);
    if (b?.char !== '[' || b.parent < 0) return false;
    return this.keyBefore(open) !== undefined && this.isObjectLiteral(b.parent);
  }

  /** How a string is used: a property value (with its key), an array item, or neither. */
  roleOf(
    str: ScannedString,
  ): { kind: 'value'; key: string } | { kind: 'item'; key: string } | undefined {
    const next = nextCode(this.text, str.end);
    const ends = /^([,}\]]|as\s|satisfies\s|$)/.test(next);
    if (!ends || str.parent < 0) return undefined;
    const parent = this.structure.brackets.get(str.parent);
    if (parent?.char === '{') {
      const key = this.keyBefore(str.start);
      return key !== undefined && this.isObjectLiteral(str.parent)
        ? { kind: 'value', key }
        : undefined;
    }
    if (parent?.char === '[' && this.isPropertyArray(str.parent)) {
      const prev = stripComments(this.text.slice(Math.max(0, str.start - 50), str.start))
        .trimEnd()
        .slice(-1);
      if (prev !== '[' && prev !== ',') return undefined;
      return { kind: 'item', key: this.keyBefore(str.parent) as string };
    }
    return undefined;
  }
}

/**
 * Encrypts a profile file (e.g. app.profile.ts): in object literals, string values of
 * sensitive-looking keys (and items of arrays under them), and property values or array items
 * equal to one of `secretValues` (values already encrypted from the env file). Keys, types,
 * imports and other code are never touched; messages name keys, never values.
 */
export function encryptProfileText(
  text: string,
  cfg: EnvEncryptionConfig,
  secret: EnvSecret,
  secretValues: Set<string>,
  file = 'profile file',
): EncryptResult {
  const pairs: SealedPair[] = [];
  const seal = sealer(cfg, secret, pairs);
  const encrypted: string[] = [];
  const committed: string[] = [];
  const shape = new ProfileShape(text);
  const sealedAt = new Set<number>();
  let out = '';
  let last = 0;
  for (const str of shape.strings) {
    if (str.content === '') continue;
    const role = shape.roleOf(str);
    if (!role) continue;
    const value = unescapeString(str.content);
    const sensitive = isSensitiveKey(role.key);
    if (!sensitive && !secretValues.has(value)) continue;
    if (refusesCommitted(cfg) && isEncMarked(value)) {
      committed.push(role.key);
      continue;
    }
    out += text.slice(last, str.start) + str.quote + seal(value, role.key) + str.quote;
    last = str.end;
    sealedAt.add(str.start);
    encrypted.push(sensitive ? role.key : `${role.key} (same value as an env field)`);
  }
  out += text.slice(last);
  refuseCommittedEnc(cfg, file, [...new Set(committed)]);
  return {
    text: out,
    encrypted: [...new Set(encrypted)],
    skipped: sensitiveNonLiterals(text, shape, sealedAt),
    values: plaintexts(pairs),
    pairs,
  };
}

/**
 * Sensitive-looking properties of object literals whose value is neither a plain string, a
 * nested object or array, nor a boolean/number: left as they are, so the build names them.
 */
function sensitiveNonLiterals(text: string, shape: ProfileShape, sealedAt: Set<number>): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/(['"]?)([A-Za-z_$][\w$-]*)\1\s*:/g)) {
    const at = m.index ?? 0;
    const key = m[2];
    if (!isSensitiveKey(key) || !isCodeAt(text, at)) continue;
    const valueAt = at + m[0].length;
    if (shape.keyBefore(valueAt) !== key) continue;
    const next = nextCode(text, valueAt);
    if (next[0] === "'" || next[0] === '"') {
      // A string after a sensitive key that was not encrypted (unknown context, concatenation…).
      const str = shape.strings.find(
        (s) => s.start >= valueAt && text.slice(valueAt, s.start).trim() === '',
      );
      // An empty string holds nothing to encrypt (a default or reset value).
      if (str && str.content !== '' && !sealedAt.has(str.start)) keys.add(key);
      continue;
    }
    if (/^([{[]|true\b|false\b|null\b|undefined\b|-?\d)/.test(next)) continue;
    // Other values only in object literals (not interfaces, parameters or type annotations).
    const parent = enclosingBrace(shape, at);
    if (parent < 0 || !shape.isObjectLiteral(parent)) continue;
    keys.add(key);
  }
  return [...keys];
}

/** The innermost `{` that encloses `index`, or -1. */
function enclosingBrace(shape: ProfileShape, index: number): number {
  let best = -1;
  for (const [open, b] of shape.brackets) {
    if (b.char === '{' && open < index && index < b.close && open > best) best = open;
  }
  return best;
}

/** Sets declared string fields (e.g. timeStamp, branch) to the given values. */
export function setStringFields(
  text: string,
  values: Record<string, string>,
): {
  text: string;
  set: string[];
} {
  const set: string[] = [];
  let out = '';
  let last = 0;
  for (const f of environmentFields(text)) {
    const v = values[f.key];
    if (v === undefined || f.kind !== 'string') continue;
    const q = text[f.start] === '`' ? "'" : text[f.start];
    const escaped = v.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`);
    out += text.slice(last, f.start) + q + escaped + q;
    last = f.end;
    set.push(f.key);
  }
  out += text.slice(last);
  return { text: out, set };
}
