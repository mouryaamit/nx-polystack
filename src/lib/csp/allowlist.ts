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

export interface CspAllowlist {
  sources: Partial<Record<CspDirective, string[]>>;
  permissionsPolicy: string;
}

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
  if (source.startsWith("'")) {
    return "quoted keywords other than 'self' (and 'wasm-unsafe-eval' in script-src) are not allowed";
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
    if (!(key in CSP_DIRECTIVES)) {
      throw new Error(
        `csp-allowlist.json: "${key}" is not supported (use ${Object.keys(CSP_DIRECTIVES).join(
          ', ',
        )}, permissions-policy)`,
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

/** JSON for the file: directives in table order, then permissions-policy when not the default. */
export function serializeAllowlist(a: CspAllowlist): string {
  const obj: Record<string, unknown> = {};
  for (const d of Object.keys(CSP_DIRECTIVES) as CspDirective[]) {
    if (a.sources[d] && (a.sources[d] as string[]).length > 0) obj[d] = a.sources[d];
  }
  if (a.permissionsPolicy !== DEFAULT_PERMISSIONS_POLICY)
    obj['permissions-policy'] = a.permissionsPolicy;
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
