/** Directives an app may extend in csp-allowlist.json, and what each starts from. */
export const CSP_DIRECTIVES = {
  'script-src': { base: ["'self'", "'nonce-{N}'"], always: true },
  'style-src': { base: ["'self'", "'nonce-{N}'"], always: true },
  'img-src': { base: ["'self'", 'data:'], always: true },
  'font-src': { base: ["'self'", 'data:'], always: true },
  'connect-src': { base: ["'self'"], always: true },
  'frame-src': { base: ["'self'"], always: false },
  'media-src': { base: ["'self'"], always: false },
  'worker-src': { base: ["'self'"], always: false },
  'manifest-src': { base: ["'self'"], always: false },
  'form-action': { base: ["'self'"], always: true },
  'frame-ancestors': { base: ["'none'"], always: true },
} as const;

export type CspDirective = keyof typeof CSP_DIRECTIVES;

export const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()';

export const DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin';
export const REFERRER_POLICIES = [
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
];
export const DEFAULT_NONCE_SOURCE = 'mod_unique_id';
/** SSI scope in .htaccess: index = IncludesNOEXEC on index.html only; html = Includes on every .html. */
export type SsiScope = 'index' | 'html';

export interface CspAllowlist {
  sources: Partial<Record<CspDirective, string[]>>;
  permissionsPolicy: string;
  /** "mod_unique_id" (UNIQUE_ID with "@" replaced, via SetEnvIfExpr) or "env:NAME" (used as is). */
  nonceSource?: string;
  /** Headers removed before the policy is set (Apache), so an upstream one cannot stack with it. */
  unsetHeaders?: string[];
  referrerPolicy?: string;
  /** Apache `Header always set <name> "<value>"` lines, written as given. */
  extraHeaders?: [string, string][];
  ssi?: SsiScope;
}

/** The env variable the nonce comes from with nonce-source "env:NAME", else undefined. */
export const nonceEnvVar = (a: CspAllowlist): string | undefined =>
  a.nonceSource?.startsWith('env:') ? a.nonceSource.slice(4) : undefined;

const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 'sha256-…' / 'sha384-…' / 'sha512-…' with base64 of that digest's length. */
const HASH_SOURCE = /^'sha(256|384|512)-([A-Za-z0-9+/_-]+={0,2})'$/i;

/** Whether source is a well-formed CSP hash source (base64 or base64url of a full digest). */
export function isHashSource(source: string): boolean {
  const m = HASH_SOURCE.exec(source);
  if (!m) return false;
  const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length * 8 !== Number(m[1])) return false;
  // Canonical: re-encoding gives the same digits (no stray bits, padding only where due).
  return bytes.toString('base64').replace(/=+$/, '') === b64.replace(/=+$/, '');
}

/** Headers pstack csp sets itself; extra-headers may not replace them. */
const RESERVED_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'strict-transport-security',
  'permissions-policy',
];

/** Host sources: https/wss (or no scheme), optional *. prefix, port and a plain path. */
const HOST =
  /^(?:(?:https|wss):\/\/)?(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::(?:\d{1,5}|\*))?(?:\/[A-Za-z0-9._~!&()*+=:@/-]*)?$/;
const SCHEMES = new Set(['https:', 'wss:', 'data:', 'blob:']);
/** Keywords written without quotes by mistake. */
const BARE_KEYWORDS = new Set(['self', 'none', 'unsafe-inline', 'unsafe-eval', 'strict-dynamic']);
/** Characters a Permissions-Policy value may hold (structured fields); `"` is escaped on output. */
const PERMISSIONS_POLICY = /^[A-Za-z0-9=(),;*:"/. _-]*$/;

/** Why a source cannot be used in a directive, or undefined when it can. */
export function sourceProblem(directive: CspDirective, source: string): string | undefined {
  if (source === "'self'") return undefined;
  // WebAssembly compilation only; no JavaScript eval.
  if (source === "'wasm-unsafe-eval'" && directive === 'script-src') return undefined;
  if (/^'sha(256|384|512)-/i.test(source)) {
    if (directive !== 'script-src' && directive !== 'style-src') {
      return 'hash sources only apply to script-src and style-src';
    }
    return isHashSource(source) ? undefined : 'not a valid sha256/384/512 hash (base64 digest)';
  }
  if (source.startsWith("'")) {
    return "quoted keywords other than 'self', hashes (and 'wasm-unsafe-eval' in script-src) are not allowed";
  }
  if (source === '*') return '"*" allows any host';
  if (SCHEMES.has(source)) {
    if (directive === 'script-src' || directive === 'style-src') {
      return `a bare scheme (${source}) would allow any source and make the nonce pointless`;
    }
    return undefined;
  }
  if (BARE_KEYWORDS.has(source.toLowerCase())) return `write it quoted ('${source}')`;
  if (/[\s;,"]/.test(source)) return 'spaces, ; , and quotes are not allowed';
  if (/[%$\\`]/.test(source)) return '% $ \\ and ` are not allowed';
  if (/^(?:http|ws):\/\//i.test(source)) return 'use https:// or wss:// (the policy upgrades http)';
  if (!HOST.test(source) || !/[A-Za-z]/.test(source)) return 'not a host or scheme source';
  return undefined;
}

/**
 * Reads csp-allowlist.json content: { "<directive>": [sources], "permissions-policy": "…" }.
 * Throws naming the key and source on anything unknown or unsafe.
 */
export function parseAllowlist(raw: unknown): CspAllowlist {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('csp-allowlist.json must be an object of directive → list of sources');
  }
  const out: CspAllowlist = { sources: {}, permissionsPolicy: DEFAULT_PERMISSIONS_POLICY };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'permissions-policy') {
      if (typeof value !== 'string' || !PERMISSIONS_POLICY.test(value)) {
        throw new Error(
          'csp-allowlist.json "permissions-policy" must be one line of letters, digits and = ( ) , ; * : " / . _ - spaces',
        );
      }
      out.permissionsPolicy = value.trim();
      continue;
    }
    if (key in OPTION_KEYS) {
      OPTION_KEYS[key](value, out);
      continue;
    }
    if (!(key in CSP_DIRECTIVES)) {
      throw new Error(
        `csp-allowlist.json: "${key}" is not supported (use ${Object.keys(CSP_DIRECTIVES).join(
          ', ',
        )}, permissions-policy, ${Object.keys(OPTION_KEYS).join(', ')})`,
      );
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new Error(`csp-allowlist.json "${key}" must be a list of sources`);
    }
    const directive = key as CspDirective;
    const sources: string[] = [];
    for (const v of value as string[]) {
      const source = v.trim();
      const problem = sourceProblem(directive, source);
      if (problem) throw new Error(`csp-allowlist.json "${key}": "${source}" — ${problem}`);
      if (!sources.includes(source)) sources.push(source);
    }
    out.sources[directive] = sources;
  }
  return out;
}

const fail = (key: string, what: string): never => {
  throw new Error(`csp-allowlist.json "${key}" ${what}`);
};

/** The server-config keys of csp-allowlist.json (everything that is not a directive). */
const OPTION_KEYS: Record<string, (value: unknown, out: CspAllowlist) => void> = {
  'nonce-source': (v, out) => {
    if (
      typeof v !== 'string' ||
      (v !== DEFAULT_NONCE_SOURCE && !(v.startsWith('env:') && ENV_NAME.test(v.slice(4))))
    ) {
      fail('nonce-source', 'must be "mod_unique_id" or "env:<VARIABLE>" (e.g. env:UNIQUE_ID)');
    }
    if (v !== DEFAULT_NONCE_SOURCE) out.nonceSource = v as string;
  },
  'unset-headers': (v, out) => {
    if (!Array.isArray(v) || !v.every((h) => typeof h === 'string' && HEADER_NAME.test(h))) {
      fail('unset-headers', 'must be a list of header names');
    }
    out.unsetHeaders = [...new Set(v as string[])];
  },
  'referrer-policy': (v, out) => {
    if (typeof v !== 'string' || !REFERRER_POLICIES.includes(v)) {
      fail('referrer-policy', `must be one of ${REFERRER_POLICIES.join(', ')}`);
    }
    if (v !== DEFAULT_REFERRER_POLICY) out.referrerPolicy = v as string;
  },
  'extra-headers': (v, out) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      fail('extra-headers', 'must be an object of header name → value');
    }
    const entries = Object.entries(v as Record<string, unknown>);
    for (const [name, value] of entries) {
      if (!HEADER_NAME.test(name)) fail('extra-headers', `: "${name}" is not a header name`);
      if (RESERVED_HEADERS.includes(name.toLowerCase())) {
        fail(
          'extra-headers',
          `: "${name}" is set from the allowlist itself (use the directives, permissions-policy or referrer-policy)`,
        );
      }
      if (typeof value !== 'string' || !value || /["\\\r\n]/.test(value)) {
        fail('extra-headers', `: "${name}" must be one line without " or \\`);
      }
    }
    out.extraHeaders = entries as [string, string][];
  },
  ssi: (v, out) => {
    if (v !== 'index' && v !== 'html') {
      fail('ssi', 'must be "index" (IncludesNOEXEC on index.html) or "html" (Includes on .html)');
    }
    if (v === 'html') out.ssi = 'html';
  },
};

/** JSON for the file: directives in table order, then permissions-policy when not the default. */
export function serializeAllowlist(a: CspAllowlist): string {
  const obj: Record<string, unknown> = {};
  for (const d of Object.keys(CSP_DIRECTIVES) as CspDirective[]) {
    if (a.sources[d] && (a.sources[d] as string[]).length > 0) obj[d] = a.sources[d];
  }
  if (a.permissionsPolicy !== DEFAULT_PERMISSIONS_POLICY)
    obj['permissions-policy'] = a.permissionsPolicy;
  if (a.nonceSource && a.nonceSource !== DEFAULT_NONCE_SOURCE) obj['nonce-source'] = a.nonceSource;
  if (a.ssi === 'html') obj['ssi'] = a.ssi;
  if (a.referrerPolicy && a.referrerPolicy !== DEFAULT_REFERRER_POLICY) {
    obj['referrer-policy'] = a.referrerPolicy;
  }
  if (a.unsetHeaders?.length) obj['unset-headers'] = a.unsetHeaders;
  if (a.extraHeaders?.length) obj['extra-headers'] = Object.fromEntries(a.extraHeaders);
  return JSON.stringify(obj, null, 2) + '\n';
}

/** The CSP with `{N}` where the per-request nonce goes. */
export function buildPolicy(a: CspAllowlist): string {
  const parts = ["default-src 'self'"];
  for (const [d, spec] of Object.entries(CSP_DIRECTIVES) as [
    CspDirective,
    (typeof CSP_DIRECTIVES)[CspDirective],
  ][]) {
    const extra = a.sources[d] ?? [];
    if (!spec.always && extra.length === 0) continue;
    const base: string[] =
      d === 'frame-ancestors' && extra.length > 0 ? [] : [...(spec.base as readonly string[])];
    const all = [...base, ...extra.filter((s) => !base.includes(s))];
    parts.push(`${d} ${all.join(' ')}`);
    if (d === 'style-src') parts.push("style-src-attr 'unsafe-inline'");
    if (d === 'connect-src') parts.push("object-src 'none'", "base-uri 'self'");
  }
  parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}
