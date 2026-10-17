import { emptyEnvironmentText, emptyJson } from '../../src/lib/env/empty';

describe('emptyEnvironmentText', () => {
  it('empties every value by type, keeping keys, comments and layout', () => {
    const source = [
      "import { Env } from './env';",
      '',
      '// UAT settings',
      'export const environment: Env = {',
      '  production: true,',
      "  envName: 'uat', // shown in the footer",
      '  apiBaseUrl: "https://uat.example.com/api",',
      '  retries: 3,',
      '  ratio: -0.5,',
      '  hex: 0xff,',
      '  password: ENC(abc),',
      "  token: '${PL_UAT_TOKEN}',",
      '  tmpl: `plain`,',
      "  hosts: ['a.example.com', 'b.example.com'],",
      '  nothing: null,',
      '  missing: undefined,',
      "  feature: { enabled: true, name: 'x', limits: { max: 10, list: [1, 2] } },",
      "  mode: 'a' as const,",
      '  computed: `${location.origin}/api`,',
      '  fromVar: someValue,',
      '};',
      '',
    ].join('\n');
    const r = emptyEnvironmentText(source);
    expect(r.text).toBe(
      [
        "import { Env } from './env';",
        '',
        '// UAT settings',
        'export const environment: Env = {',
        '  production: true,',
        "  envName: '', // shown in the footer",
        '  apiBaseUrl: "",',
        '  retries: 0,',
        '  ratio: 0,',
        '  hex: 0,',
        "  password: '',",
        "  token: '',",
        '  tmpl: ``,',
        '  hosts: [],',
        '  nothing: null,',
        '  missing: undefined,',
        "  feature: { enabled: false, name: '', limits: { max: 0, list: [] } },",
        "  mode: '' as const,",
        "  computed: '',",
        "  fromVar: '',",
        '};',
        '',
      ].join('\n'),
    );
    expect(r.expressions).toEqual(['password', 'computed', 'fromVar']);
    expect(r.unkeyed).toEqual([]);
  });

  it('can empty production too (no kept keys)', () => {
    const r = emptyEnvironmentText('export const environment = { production: true };\n', []);
    expect(r.text).toBe('export const environment = { production: false };\n');
  });

  it('lists spread and shorthand entries it leaves alone', () => {
    const r = emptyEnvironmentText("export const environment = { ...base, apiUrl, name: 'x' };\n");
    expect(r.text).toBe("export const environment = { ...base, apiUrl, name: '' };\n");
    expect(r.unkeyed).toEqual(['...base', 'apiUrl']);
  });

  it('throws when there is no environment object', () => {
    expect(() => emptyEnvironmentText('export const x = 1;\n')).toThrow(/environment = \{/);
  });
});

describe('emptyJson', () => {
  it('empties nested JSON by type', () => {
    expect(
      emptyJson({
        FLUTTER_ENV: 'uat',
        API_BASE_URL: 'https://uat.example.com',
        RETRIES: 3,
        DEBUG: true,
        HOSTS: ['a'],
        NESTED: { A: 'x', B: { C: 1 } },
        NOTHING: null,
      }),
    ).toEqual({
      FLUTTER_ENV: '',
      API_BASE_URL: '',
      RETRIES: 0,
      DEBUG: false,
      HOSTS: [],
      NESTED: { A: '', B: { C: 0 } },
      NOTHING: null,
    });
  });
});
