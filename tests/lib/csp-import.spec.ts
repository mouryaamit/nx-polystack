import { parseAllowlist } from '../../src/lib/csp/allowlist';
import {
  coveringSource,
  importPolicy,
  parseJsonPolicy,
  parsePolicyText,
  policiesInServerConfig,
  readPolicy,
} from '../../src/lib/csp/import';

describe('csp import (NX-49)', () => {
  describe('reading', () => {
    it('parses a header value, merging repeated directives', () => {
      expect(
        parsePolicyText(
          "default-src 'self'; script-src 'self' https://a.example.com;  img-src data: ; script-src https://b.example.com",
        ),
      ).toEqual({
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://a.example.com', 'https://b.example.com'],
        'img-src': ['data:'],
      });
    });

    it('finds the policy in Apache and Nginx configs, not Report-Only', () => {
      const apache =
        "Header always set Content-Security-Policy \"script-src 'self' 'nonce-%{CSP_NONCE}e' https://cdn.example.com; connect-src https://api.example.com\"\n" +
        'Header set Content-Security-Policy-Report-Only "script-src https://report.example.com"\n';
      expect(policiesInServerConfig(apache)).toEqual([
        "script-src 'self' 'nonce-%{CSP_NONCE}e' https://cdn.example.com; connect-src https://api.example.com",
      ]);
      const nginx =
        '  add_header Content-Security-Policy "img-src \'self\' https://img.example.com" always;\n';
      expect(readPolicy(nginx)).toMatchObject({
        format: 'server-config',
        policy: { 'img-src': ["'self'", 'https://img.example.com'] },
      });
    });

    it('reads JSON: plain, directives, suggestedPolicy.directives and string values', () => {
      expect(parseJsonPolicy({ 'connect-src': ['https://a.example.com'] })).toEqual({
        'connect-src': ['https://a.example.com'],
      });
      expect(
        parseJsonPolicy({
          app: 'x',
          suggestedPolicy: { directives: { 'Script-Src': "'self' https://a.example.com" } },
        }),
      ).toEqual({ 'script-src': ["'self'", 'https://a.example.com'] });
      expect(readPolicy('{ "directives": { "font-src": ["https://f.example.com"] } }').format).toBe(
        'json',
      );
      expect(() => readPolicy('{ nope')).toThrow('not valid JSON');
      expect(readPolicy("Content-Security-Policy: img-src 'self'").policy).toEqual({
        'img-src': ["'self'"],
      });
    });
  });

  describe('covered sources', () => {
    it.each([
      ['https://a.example.com/x.js', ['https://a.example.com'], 'https://a.example.com'],
      ['https://a.example.com/v3/x.js', ['https://a.example.com/v3/'], 'https://a.example.com/v3/'],
      ['https://cdn.a.example.com', ['https://*.a.example.com'], 'https://*.a.example.com'],
      ['https://a.example.com/x.js', ['a.example.com'], 'a.example.com'],
      ['https://*.a.example.com/collect', ['https://*.a.example.com'], 'https://*.a.example.com'],
    ])('%s is covered by %j', (source, list, by) => {
      expect(coveringSource(source, [...list, source])).toBe(by);
    });

    it.each([
      ['wss://chat.example.com', ['https://chat.example.com']],
      ['https://a.example.com/v4/x.js', ['https://a.example.com/v3/']],
      ['https://a.example.com/v3', ['https://a.example.com/v3']],
      ['https://a.example.com:8443/x', ['https://a.example.com']],
      ['https://a.example.com', ['https://*.a.example.com']],
      ['data:', ['https://a.example.com']],
    ])('%s is not covered by %j', (source, list) => {
      expect(coveringSource(source, [...list, source])).toBeUndefined();
    });
  });

  describe('review cases', () => {
    it('does not treat a scheme-less host as covering wss://, and keeps existing entries', () => {
      expect(coveringSource('wss://ws.x.com', ['*.x.com', 'wss://ws.x.com'])).toBeUndefined();
      expect(coveringSource('wss://a.com/s', ['a.com', 'wss://a.com/s'])).toBeUndefined();
      expect(coveringSource('https://a.com/s', ['a.com', 'https://a.com/s'])).toBe('a.com');
      const r = importPolicy(
        { 'connect-src': ['https://other.com'] },
        { 'connect-src': ['*.x.com', 'wss://ws.x.com'] },
      );
      expect(r.sources['connect-src']).toEqual(['*.x.com', 'wss://ws.x.com', 'https://other.com']);
    });

    it('reads Apache continuations, onsuccess and one-line Nginx blocks, and notes several policies', () => {
      const apache =
        "Header onsuccess set Content-Security-Policy \"default-src 'self'; \\\n" +
        '    script-src https://cdn.x.com"\n';
      expect(readPolicy(apache).policy).toEqual({
        'default-src': ["'self'"],
        'script-src': ['https://cdn.x.com'],
      });
      const nginx =
        'location / { add_header Content-Security-Policy "script-src https://b.com" always; }\n' +
        '# add_header Content-Security-Policy "script-src https://commented.com";\n' +
        'add_header Content-Security-Policy "script-src https://a.com";\n';
      const read = readPolicy(nginx);
      expect(read.policy['script-src']).toEqual(['https://b.com', 'https://a.com']);
      expect(read.policies).toBe(2);
      expect(read.notes[0]).toContain('2 Content-Security-Policy headers found');
    });

    it('lists default-src extras and the directives that relied on them', () => {
      const r = importPolicy(
        parsePolicyText("default-src 'self' https://cdn.x.com; script-src 'self'"),
        {},
      );
      expect(r.skipped[0]).toMatchObject({ directive: 'default-src', kind: 'not-taken' });
      expect(r.skipped[0].reason).toContain('https://cdn.x.com');
      expect(r.notes[0]).toContain('default-src allowed https://cdn.x.com for style-src, img-src');
      expect(r.notes[0]).not.toContain('script-src,');
    });

    it('re-importing the generated policy adds nothing', () => {
      const generated =
        "default-src 'self'; script-src 'self' 'nonce-abc'; style-src 'self' 'nonce-abc'; " +
        "style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
        "frame-ancestors 'none'; upgrade-insecure-requests";
      const r = importPolicy(parsePolicyText(generated), {});
      expect(r.sources).toEqual({});
      expect(r.skipped).toEqual([]);
    });

    it('ignores case for keywords and hosts, reports report-uri and odd JSON', () => {
      const r = importPolicy(
        { 'script-src': ["'SELF'", "'NONCE-x'", 'https://CDN.x.com'], 'report-uri': ['/csp'] },
        { 'script-src': ['https://cdn.x.com'] },
      );
      expect(r.added).toEqual({});
      expect(r.skipped).toEqual([
        expect.objectContaining({ directive: 'report-uri', kind: 'not-taken' }),
      ]);
      const notes: string[] = [];
      expect(
        parseJsonPolicy(
          { 'img-src': ['https://a.com', 5], 'permissions-policy': 'camera=()', 'font-src': 3 },
          notes,
        ),
      ).toEqual({ 'img-src': ['https://a.com'] });
      expect(notes).toEqual([
        'img-src: entries that are not text were ignored',
        'font-src: not a list or text, ignored',
      ]);
    });
  });

  describe('importPolicy', () => {
    const policy = {
      'default-src': ["'self'"],
      'script-src': [
        "'self'",
        "'nonce-{NONCE}'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        "'wasm-unsafe-eval'",
        'https://www.tags.example.com',
        'https://cdn.example.com',
        'https://cdn.example.com/chat.js',
        'http://old.example.com',
        'data:',
      ],
      'script-src-elem': ["'self'", 'https://elem.example.com'],
      'connect-src': ["'self'", 'blob:', 'https://api.example.com', 'wss://chat.example.com'],
      'object-src': ["'none'", 'data:'],
      'frame-ancestors': ["'self'", 'https://partner.example.com'],
      'style-src-attr': ["'unsafe-inline'"],
    };

    it('merges what the strict policy accepts and reports the rest', () => {
      const r = importPolicy(policy, { 'connect-src': ['https://existing.example.com'] });
      expect(r.sources).toEqual({
        'connect-src': [
          'https://existing.example.com',
          'blob:',
          'https://api.example.com',
          'wss://chat.example.com',
        ],
        'script-src': [
          "'wasm-unsafe-eval'",
          'https://www.tags.example.com',
          'https://cdn.example.com',
          'https://elem.example.com',
        ],
        'frame-ancestors': ["'self'", 'https://partner.example.com'],
      });
      expect(r.added['connect-src']).toEqual([
        'blob:',
        'https://api.example.com',
        'wss://chat.example.com',
      ]);
      expect(r.covered).toEqual([
        {
          directive: 'script-src',
          source: 'https://cdn.example.com/chat.js',
          by: 'https://cdn.example.com',
        },
      ]);
      const skipped = r.skipped.map((s) => `${s.directive} ${s.source ?? ''}`.trim());
      expect(skipped).toEqual([
        "script-src 'unsafe-inline'",
        "script-src 'unsafe-eval'",
        'script-src http://old.example.com',
        'script-src data:',
        'object-src',
      ]);
      expect(r.skipped.filter((s) => s.kind === 'refused')).toHaveLength(4);
      // NX-70: script-src-elem is merged into script-src.
      expect(r.notes).toContain(
        'script-src-elem was merged into script-src (the generated policy sets script-src only)',
      );
      // The result is a valid allowlist.
      expect(() => parseAllowlist(r.sources)).not.toThrow();
    });

    it('is idempotent and never removes existing entries', () => {
      const once = importPolicy(policy, {});
      const twice = importPolicy(policy, once.sources);
      expect(twice.sources).toEqual(once.sources);
      expect(twice.added).toEqual({});
      const r = importPolicy(
        { 'img-src': ['https://img.example.com'] },
        { 'img-src': ['https://img.example.com/a.png'] },
      );
      expect(r.sources['img-src']).toEqual([
        'https://img.example.com/a.png',
        'https://img.example.com',
      ]);
    });

    it('notes an input without a policy', () => {
      expect(importPolicy({}, {}).notes).toEqual(['no Content-Security-Policy found in the input']);
    });
  });

  describe('hash sources (NX-70)', () => {
    const h256 = `'sha256-${'A'.repeat(43)}='`;
    const h384 = `'sha384-${'aB+/'.repeat(16)}'`;

    it('keeps hashes from script-src-elem and style-src, digest case untouched', () => {
      const read = readPolicy(
        `script-src-elem 'self' ${h256} 'SHA384-${'aB+/'.repeat(
          16,
        )}'; style-src 'self' ${h384}; img-src ${h256}`,
      );
      const r = importPolicy(read.policy, {});
      expect(r.sources['script-src']).toEqual([h256, h384]);
      expect(r.sources['style-src']).toEqual([h384]);
      expect(r.sources['img-src']).toBeUndefined();
      expect(() => parseAllowlist(r.sources)).not.toThrow();
    });

    it('refuses malformed hashes and hashes outside script-src/style-src', () => {
      expect(() => parseAllowlist({ 'script-src': ["'sha256-short'"] })).toThrow(/valid sha256/);
      expect(() => parseAllowlist({ 'img-src': [h256] })).toThrow(/script-src and style-src/);
      expect(parseAllowlist({ 'script-src': [h256] }).sources['script-src']).toEqual([h256]);
    });
  });
});
