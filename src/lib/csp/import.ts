import { CSP_DIRECTIVES, CspAllowlist, CspDirective, sourceProblem } from './allowlist';

/** directive → sources, as read from a policy, a server config or JSON. */
export type RawPolicy = Record<string, string[]>;

export type ImportFormat = 'policy' | 'server-config' | 'json';

export interface Skipped {
  directive: string;
  source?: string;
  reason: string;
  /** refused: the strict policy does not allow it; not-taken: the generated policy has no place for it. */
  kind: 'refused' | 'not-taken';
}

export interface ImportResult {
  /** The merged allowlist sources (existing + imported, covered imports dropped). */
  sources: CspAllowlist['sources'];
  /** directive → sources that were not in the allowlist before. */
  added: Record<string, string[]>;
  skipped: Skipped[];
  /** Imported sources not added because an entry of the same directive already allows them. */
  covered: Array<{ directive: string; source: string; by: string }>;
  notes: string[];
}

export interface ReadPolicyResult {
  format: ImportFormat;
  policy: RawPolicy;
  /** Number of Content-Security-Policy headers found (server configs). */
  policies: number;
  notes: string[];
}

/** Directives the generated policy sets itself. */
const FIXED: Record<string, string> = {
  'default-src': "the generated policy uses default-src 'self'",
  'object-src': "the generated policy uses object-src 'none'",
  'base-uri': "the generated policy uses base-uri 'self'",
  'style-src-attr': "the generated policy uses style-src-attr 'unsafe-inline'",
  'upgrade-insecure-requests': 'the generated policy upgrades insecure requests',
};

/** What each fixed directive already allows (anything else is reported). */
const FIXED_ALLOWS: Record<string, string[]> = {
  'default-src': ["'self'", "'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'", "'none'"],
  'style-src-attr': ["'unsafe-inline'", "'self'", "'none'"],
  'upgrade-insecure-requests': [],
};

/** Directives that fall back to default-src when a policy does not set them. */
const DEFAULT_SRC_FALLBACK: CspDirective[] = [
  'script-src',
  'style-src',
  'img-src',
  'font-src',
  'connect-src',
  'media-src',
  'frame-src',
  'worker-src',
  'manifest-src',
];

const lower = (s: string) => (s.startsWith("'") ? s.toLowerCase() : s);

/** Sources the generated policy already has, or that the server adds per request. */
function implied(directive: string, source: string): boolean {
  const s = lower(source);
  if (/^'(nonce|sha256|sha384|sha512)-/.test(s)) return true;
  if (s === "'self'" && directive !== 'frame-ancestors') return true;
  const base = (CSP_DIRECTIVES as Record<string, { base: readonly string[] }>)[directive]?.base;
  return !!base && base.includes(s) && s !== "'none'";
}

/** A raw `Content-Security-Policy` value: `directive source source; directive …`. */
export function parsePolicyText(text: string): RawPolicy {
  const out: RawPolicy = {};
  for (const part of text.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    const directive = name.toLowerCase();
    out[directive] = [...(out[directive] ?? []), ...sources];
  }
  return out;
}

/** Apache/Nginx header lines that set a Content-Security-Policy (not Report-Only). */
const HEADER_LINE =
  /(?:^|[\n{;])[ \t]*(?:Header\s+(?:(?:always|onsuccess)\s+)?(?:set|add|append|merge)|add_header|more_set_headers)\s+["']?Content-Security-Policy:?["']?\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'([^']*)')/gi;

/**
 * Every Content-Security-Policy set in an Apache (`Header … Content-Security-Policy "…"`) or
 * Nginx (`add_header Content-Security-Policy "…"`) config, also inside one-line blocks and across
 * `\` line continuations; Report-Only headers are not read.
 */
export function policiesInServerConfig(text: string): string[] {
  const joined = text.replace(/\\\r?\n[ \t]*/g, ' ');
  const out: string[] = [];
  HEADER_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADER_LINE.exec(joined)) !== null) {
    out.push((m[1] ?? m[2] ?? '').replace(/\\"/g, '"'));
  }
  return out;
}

/** Keys of csp-allowlist.json that are not directives. */
const NOT_DIRECTIVES = new Set(['permissions-policy']);

/** directive → sources from JSON: an object of lists or strings, under `directives` or `suggestedPolicy.directives` too. */
export function parseJsonPolicy(value: unknown, notes: string[] = []): RawPolicy {
  let obj = value as Record<string, unknown>;
  const suggested = obj?.['suggestedPolicy'];
  if (suggested && typeof suggested === 'object') obj = suggested as Record<string, unknown>;
  if (obj?.['directives'] && typeof obj['directives'] === 'object') {
    obj = obj['directives'] as Record<string, unknown>;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('the JSON is not an object of directives');
  }
  const out: RawPolicy = {};
  for (const [key, v] of Object.entries(obj)) {
    const directive = key.toLowerCase();
    if (NOT_DIRECTIVES.has(directive)) continue;
    if (Array.isArray(v)) {
      const strings = v.filter((s): s is string => typeof s === 'string');
      if (strings.length !== v.length) notes.push(`${key}: entries that are not text were ignored`);
      out[directive] = strings.flatMap((s) => s.split(/\s+/).filter(Boolean));
    } else if (typeof v === 'string') {
      out[directive] = v.split(/\s+/).filter(Boolean);
    } else if (/-(src|uri|ancestors|action)$/.test(directive)) {
      notes.push(`${key}: not a list or text, ignored`);
    }
  }
  return out;
}

/** Reads a policy from file content or text, detecting the format. */
export function readPolicy(text: string): ReadPolicyResult {
  const trimmed = text.trim();
  const notes: string[] = [];
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`not valid JSON (${(err as Error).message})`);
    }
    return { format: 'json', policy: parseJsonPolicy(parsed, notes), policies: 1, notes };
  }
  if (
    /(?:Header\s+(?:(?:always|onsuccess)\s+)?\w+|add_header|more_set_headers)\s+["']?Content-Security-Policy/i.test(
      trimmed,
    )
  ) {
    const found = policiesInServerConfig(trimmed);
    const policy: RawPolicy = {};
    for (const p of found) {
      for (const [d, s] of Object.entries(parsePolicyText(p))) {
        policy[d] = [...(policy[d] ?? []), ...s];
      }
    }
    if (found.length > 1) {
      notes.push(
        `${found.length} Content-Security-Policy headers found; their sources were merged. A ` +
          'browser enforces each of them, so the merged allowlist may allow more than any one did.',
      );
    }
    return { format: 'server-config', policy, policies: found.length, notes };
  }
  const body = trimmed.replace(/^Content-Security-Policy:\s*/i, '');
  return { format: 'policy', policy: parsePolicyText(body), policies: 1, notes };
}

interface ParsedHost {
  scheme: string;
  host: string;
  port: string;
  path: string;
}

function parseHost(source: string): ParsedHost | undefined {
  const m = /^(?:([a-z]+):\/\/)?(\*\.)?([A-Za-z0-9.-]+)(?::(\d+|\*))?(\/.*)?$/i.exec(source);
  if (!m || source.endsWith(':')) return undefined;
  return {
    scheme: (m[1] ?? '').toLowerCase(),
    host: `${m[2] ?? ''}${m[3]}`.toLowerCase().replace(/\.$/, ''),
    port: m[4] ?? '',
    path: m[5] ?? '',
  };
}

/** A source compared without case in its scheme and host. */
function sourceKey(source: string): string {
  const h = parseHost(source);
  if (!h) return lower(source);
  return `${h.scheme}://${h.host}:${h.port}${h.path}`;
}

/** The source in `list` that already allows `source` (a broader host entry), if any. */
export function coveringSource(source: string, list: string[]): string | undefined {
  const s = parseHost(source);
  if (!s) return undefined;
  return list.find((other) => {
    if (other === source) return false;
    const o = parseHost(other);
    if (!o) return false;
    // Without a scheme a host source means the page's scheme (https); it does not reliably
    // cover wss:// in every browser, so only https (or another scheme-less entry) counts.
    if (o.scheme !== s.scheme && !(o.scheme === '' && s.scheme === 'https')) return false;
    if (o.port !== '*' && o.port !== s.port) return false; // no port = the default port only
    const hostOk =
      o.host === s.host || (o.host.startsWith('*.') && s.host.endsWith(o.host.slice(1)));
    if (!hostOk) return false;
    // A path ending in / covers everything below it; a host without a path covers all paths.
    if (o.path === '' || o.path === '/') return s.path !== '' || o.host !== s.host;
    return o.path.endsWith('/') && s.path.startsWith(o.path) && s.path !== o.path;
  });
}

/**
 * Merges an imported policy into the allowlist sources: sources the strict policy refuses, and
 * directives it does not take, are skipped with the reason; imported sources that an entry
 * already allows are not added. Existing entries are never removed.
 */
export function importPolicy(policy: RawPolicy, existing: CspAllowlist['sources']): ImportResult {
  const skipped: Skipped[] = [];
  const notes: string[] = [];
  const incoming: Record<string, string[]> = {};

  for (const [directive, sources] of Object.entries(policy)) {
    if (directive in FIXED) {
      const extra = sources.filter((s) => !FIXED_ALLOWS[directive].includes(lower(s)));
      if (extra.length > 0) {
        skipped.push({
          directive,
          kind: 'not-taken',
          reason: `${FIXED[directive]}; not imported: ${extra.join(' ')}`,
        });
      }
      continue;
    }
    if (directive === 'report-uri' || directive === 'report-to') {
      skipped.push({
        directive,
        kind: 'not-taken',
        reason:
          `violation reports (${sources.join(' ')}) are not part of the generated policy; ` +
          'add the reporting header to the server config by hand if you need them',
      });
      continue;
    }
    if (!(directive in CSP_DIRECTIVES)) {
      const real = sources.filter((s) => !implied(directive, s) && lower(s) !== "'none'");
      skipped.push({
        directive,
        kind: 'not-taken',
        reason:
          'not a directive of the generated policy' +
          (real.length > 0 ? `; its sources were not imported: ${real.join(' ')}` : ''),
      });
      continue;
    }
    for (const source of sources) {
      if (implied(directive, source)) continue;
      if (directive === 'frame-ancestors' && lower(source) === "'none'") continue;
      const value = lower(source);
      const problem = sourceProblem(directive as CspDirective, value);
      if (problem) {
        skipped.push({ directive, source, kind: 'refused', reason: problem });
        continue;
      }
      incoming[directive] = [...(incoming[directive] ?? []), value];
    }
  }

  // A policy with default-src extras also allowed them for fetch directives it did not set.
  const fallback = (policy['default-src'] ?? []).filter(
    (s) => !FIXED_ALLOWS['default-src'].includes(lower(s)),
  );
  if (fallback.length > 0) {
    const missing = DEFAULT_SRC_FALLBACK.filter((d) => !(d in policy));
    if (missing.length > 0) {
      notes.push(
        `default-src allowed ${fallback.join(' ')} for ${missing.join(', ')} (not set in the ` +
          'imported policy); add what these need with --add=<directive>:<source>',
      );
    }
  }

  const covered: ImportResult['covered'] = [];
  const sources: CspAllowlist['sources'] = {};
  const added: Record<string, string[]> = {};
  const directives = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
  for (const directive of directives) {
    const kept = [...(existing[directive as CspDirective] ?? [])];
    const keys = new Set(kept.map(sourceKey));
    for (const source of incoming[directive] ?? []) {
      if (keys.has(sourceKey(source))) continue; // already there (any case)
      const by = coveringSource(source, kept);
      if (by) {
        covered.push({ directive, source, by });
        continue;
      }
      kept.push(source);
      keys.add(sourceKey(source));
      (added[directive] ??= []).push(source);
    }
    // An imported source may cover one imported before it: drop those (never existing ones).
    const fresh = new Set(added[directive] ?? []);
    const final = kept.filter((source) => {
      if (!fresh.has(source)) return true;
      const by = coveringSource(source, kept);
      if (!by) return true;
      covered.push({ directive, source, by });
      added[directive] = (added[directive] ?? []).filter((s) => s !== source);
      return false;
    });
    if (added[directive]?.length === 0) delete added[directive];
    if (final.length > 0) sources[directive as CspDirective] = final;
  }
  if (Object.keys(policy).length === 0) notes.push('no Content-Security-Policy found in the input');
  return { sources, added, skipped, covered, notes };
}
