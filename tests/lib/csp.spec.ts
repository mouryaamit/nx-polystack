import {
  allowlistForEnv,
  buildPolicy,
  parseAllowlist,
  serializeAllowlist,
  sourceProblem,
} from '../../src/lib/csp/allowlist';
import { GENERATED_MARKER, renderHtaccess, renderNginx } from '../../src/lib/csp/render';

describe('csp allowlist', () => {
  it.each([
    ['connect-src', 'https://api.example.com'],
    ['connect-src', 'wss://push.example.com:8443/socket'],
    ['script-src', 'https://*.googletagmanager.com'],
    ['script-src', 'www.googletagmanager.com'],
    ['img-src', 'data:'],
    ['worker-src', 'blob:'],
    ['connect-src', "'self'"],
    ['img-src', 'https:'],
    ['connect-src', 'https://api.example.com/v1/'],
    ['script-src', "'wasm-unsafe-eval'"],
    ['script-src', 'https://unpkg.com/web-vitals@3.0.0/dist/web-vitals.attribution.iife.js'],
    ['connect-src', 'data:'],
  ] as const)('accepts %s %s', (d, s) => expect(sourceProblem(d, s)).toBeUndefined());

  it.each([
    ['script-src', "'unsafe-inline'", 'quoted keywords'],
    ['script-src', "'unsafe-eval'", 'quoted keywords'],
    ['style-src', "'strict-dynamic'", 'quoted keywords'],
    ['connect-src', "'wasm-unsafe-eval'", 'quoted keywords'],
    ['connect-src', '*', 'any host'],
    ['script-src', 'data:', 'bare scheme'],
    ['script-src', 'blob:', 'bare scheme'],
    ['script-src', 'https:', 'bare scheme'],
    ['style-src', 'data:', 'bare scheme'],
    ['connect-src', 'self', "write it quoted ('self')"],
    ['frame-ancestors', 'none', 'write it quoted'],
    ['connect-src', 'http://api.example.com', 'use https://'],
    ['connect-src', 'ws://push.example.com', 'use https://'],
    ['connect-src', 'https://x.com/a%20b', '% $'],
    ['connect-src', 'https://x.com/a$b', '% $'],
    ['connect-src', 'https://a.com; script-src *', 'spaces'],
    ['connect-src', 'https://a.com,https://b.com', 'spaces'],
    ['connect-src', 'http:', 'not a host'],
    ['connect-src', '123', 'not a host'],
  ] as const)('refuses %s %s', (d, s, why) => expect(sourceProblem(d, s)).toContain(why));

  it('parses today’s files, removes duplicates and names bad entries', () => {
    expect(parseAllowlist({ 'connect-src': [] }).sources).toEqual({ 'connect-src': [] });
    expect(
      parseAllowlist({ 'connect-src': ['https://a.com', ' https://a.com '] }).sources[
        'connect-src'
      ],
    ).toEqual(['https://a.com']);
    expect(() => parseAllowlist({ 'script-src': ["'unsafe-inline'"] })).toThrow(
      `csp-allowlist.json "script-src": "'unsafe-inline'" — quoted keywords`,
    );
    expect(() => parseAllowlist({ 'default-src': [] })).toThrow('"default-src" is not supported');
    expect(() => parseAllowlist({ 'img-src': 'x' })).toThrow('"img-src" must be a list');
    expect(() => parseAllowlist([])).toThrow('must be an object');
    expect(parseAllowlist({ 'permissions-policy': 'camera=(self)' }).permissionsPolicy).toBe(
      'camera=(self)',
    );
    expect(() => parseAllowlist({ 'permissions-policy': 'camera=(self) %t' })).toThrow(
      '"permissions-policy" must be one line',
    );
    expect(() => parseAllowlist({ 'permissions-policy': 'a=$b' })).toThrow('"permissions-policy"');
  });

  it('serializes in directive order and keeps a custom permissions policy', () => {
    const a = parseAllowlist({
      'img-src': ['https://cdn.example.com'],
      'connect-src': ['https://api.example.com'],
      'frame-src': [],
      'permissions-policy': 'camera=(self)',
    });
    expect(JSON.parse(serializeAllowlist(a))).toEqual({
      'img-src': ['https://cdn.example.com'],
      'connect-src': ['https://api.example.com'],
      'permissions-policy': 'camera=(self)',
    });
    expect(Object.keys(JSON.parse(serializeAllowlist(a)))[0]).toBe('img-src');
  });

  it('builds the strict-script, compatible-style policy', () => {
    expect(buildPolicy(parseAllowlist({}))).toBe(
      "default-src 'self'; script-src 'self' 'nonce-{N}'; style-src 'self' 'nonce-{N}'; " +
        "style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
        "frame-ancestors 'none'; upgrade-insecure-requests",
    );
    const p = buildPolicy(
      parseAllowlist({
        'script-src': ['https://www.googletagmanager.com'],
        'frame-src': ['https://www.youtube.com'],
        'frame-ancestors': ["'self'"],
      }),
    );
    expect(p).toContain("script-src 'self' 'nonce-{N}' https://www.googletagmanager.com;");
    expect(p).toContain("frame-src 'self' https://www.youtube.com;");
    expect(p).toContain("frame-ancestors 'self';");
    expect(p).not.toContain("'none'; upgrade");
  });
});

describe('server config renderers', () => {
  const a = parseAllowlist({ 'connect-src': ['https://api.example.com'] });

  it('apache: marker, SPA routing, @-free nonce chain, SSI on index.html, CSP header', () => {
    const t = renderHtaccess('portal', a);
    expect(t.startsWith(`${GENERATED_MARKER} — edit it and run \`pstack csp --app=portal\`.`)).toBe(
      true,
    );
    expect(t).toContain('AllowOverride FileInfo Options=IncludesNOEXEC');
    expect(t).toContain(
      'RewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\n' +
        'RewriteCond %{REQUEST_URI} !\\.[0-9a-f]{8,}\\.(js|css)$\nRewriteRule ^ index.html [L]',
    );
    expect(t).toContain(`SetEnvIfExpr "reqenv('UNIQUE_ID') =~ /^(.+)$/" CSP_NONCE=$1`);
    expect(
      t
        .split('\n')
        .filter(
          (l) => l === `SetEnvIfExpr "reqenv('CSP_NONCE') =~ /^([^@]*)@(.*)$/" CSP_NONCE=$1_$2`,
        ),
    ).toHaveLength(8);
    expect(t).not.toMatch(/^SetEnvIf /m);
    expect(t).toContain(
      '<Files "index.html">\n    SetOutputFilter INCLUDES\n    Header always set Cache-Control "no-store"',
    );
    expect(t).toContain('Options +IncludesNOEXEC');
    expect(t).toContain(
      `Header always set Content-Security-Policy "default-src 'self'; script-src 'self' 'nonce-%{CSP_NONCE}e';`,
    );
    expect(t).toContain("connect-src 'self' https://api.example.com;");
    expect(t).toContain(
      'Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"',
    );
    expect(t).not.toContain('{N}');
  });

  it('escapes quotes of a permissions policy in both servers', () => {
    const b = parseAllowlist({
      'permissions-policy': 'geolocation=(self "https://maps.example.com")',
    });
    expect(renderHtaccess('p', b)).toContain(
      'Header always set Permissions-Policy "geolocation=(self \\"https://maps.example.com\\")"',
    );
    expect(renderNginx('p', b)).toContain(
      'add_header Permissions-Policy "geolocation=(self \\"https://maps.example.com\\")" always;',
    );
  });

  it('nginx: sub_filter nonce, headers in every location, index.html not cached', () => {
    const t = renderNginx('portal', a);
    expect(t).toContain(`sub_filter '<!--#echo var="CSP_NONCE" -->' $request_id;`);
    expect(t).toContain('sub_filter_once off;');
    expect(t.match(/add_header Content-Security-Policy "[^"]*'nonce-\$request_id'/g)).toHaveLength(
      3,
    );
    expect(t).toContain('location = /index.html {');
    expect(t).toContain('add_header Cache-Control "no-store" always;');
    expect(t).toContain('try_files $uri $uri/ /index.html;');
    expect(t).toContain('location ~* "\\.[0-9a-f]{8,}\\.(js|css)$" {');
    expect(t).toContain('add_header Cache-Control "public, max-age=31536000, immutable";');
    expect(t).not.toContain('sub_filter_types');
    expect(t).not.toContain('{N}');
  });
});

describe('csp allowlist envs (per-env sources)', () => {
  const raw = {
    'connect-src': ['https://api.example.com'],
    envs: {
      uat: { 'connect-src': ['https://uat-api.example.com', 'https://api.example.com'] },
      prod: { 'img-src': ['https://cdn.example.com'], 'frame-src': [] },
    },
  };

  it('parses envs and merges an env into the base sources without duplicates', () => {
    const a = parseAllowlist(raw);
    expect(a.envs).toEqual({
      uat: { 'connect-src': ['https://uat-api.example.com', 'https://api.example.com'] },
      prod: { 'img-src': ['https://cdn.example.com'] },
    });
    const uat = allowlistForEnv(a, 'UAT');
    expect(uat.sources['connect-src']).toEqual([
      'https://api.example.com',
      'https://uat-api.example.com',
    ]);
    expect(uat.envs).toBeUndefined();
    expect(buildPolicy(uat)).toContain(
      "connect-src 'self' https://api.example.com https://uat-api.example.com",
    );
    // An env without its own sources renders the base policy.
    expect(buildPolicy(allowlistForEnv(a, 'dev'))).toBe(buildPolicy(a));
  });

  it('serializes envs last, sorted, directives in table order', () => {
    const text = serializeAllowlist(parseAllowlist(raw));
    expect(Object.keys(JSON.parse(text))).toEqual(['connect-src', 'envs']);
    expect(Object.keys(JSON.parse(text).envs)).toEqual(['prod', 'uat']);
    expect(parseAllowlist(JSON.parse(text))).toEqual(parseAllowlist(raw));
  });

  it('refuses bad env names, options inside an env and unsafe sources', () => {
    expect(() => parseAllowlist({ envs: { UAT: {} } })).toThrow('"UAT" is not an env name');
    expect(() => parseAllowlist({ envs: { uat: { 'nonce-source': 'env:X' } } })).toThrow(
      'an env adds sources only',
    );
    expect(() => parseAllowlist({ envs: { uat: { 'script-src': ["'unsafe-inline'"] } } })).toThrow(
      'envs.uat.script-src',
    );
    expect(() => parseAllowlist({ envs: [] })).toThrow('"envs" must be an object');
  });
});
