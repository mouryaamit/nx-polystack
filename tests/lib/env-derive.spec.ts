import {
  defaultEnvEncryptionConfig,
  EnvEncryptionConfig,
} from '../../src/lib/env-encryption/config';
import { deriveEnvFile, deriveFlutterEnv, placeholderName } from '../../src/lib/env/derive';

const SOURCE = `// UAT
export const environment = {
  production: false,
  envName: 'uat',
  apiBaseUrl: 'https://uat.example.com/api',
  uname: "uat-user",
  password: 'p@ss\\'word',
  key: '\${PL_UAT_KEY}',
  timeStamp: '01 Jan',
  branch: 'main',
  empty: '',
  flags: { beta: true },
};
`;

const cfg = (over: Partial<EnvEncryptionConfig>): EnvEncryptionConfig => ({
  ...defaultEnvEncryptionConfig(),
  ...over,
});

describe('deriveEnvFile', () => {
  it('all mode: every non-public string becomes a placeholder; urls, stamp and empty values stay', () => {
    const d = deriveEnvFile(SOURCE, {
      env: 'qa',
      app: 'pl',
      envProject: 'pl',
      cfg: cfg({ mode: 'all' }),
    });
    expect(d.text).toContain("envName: 'qa'");
    expect(d.text).toContain("apiBaseUrl: 'https://uat.example.com/api'");
    expect(d.text).toContain('uname: "${PL_QA_UNAME}"');
    expect(d.text).toContain("password: '${PL_QA_PASSWORD}'");
    expect(d.text).toContain("key: '${PL_QA_KEY}'");
    expect(d.text).toContain("timeStamp: '01 Jan'");
    expect(d.text).toContain("branch: 'main'");
    expect(d.text).toContain("empty: ''");
    expect(d.text).toContain('flags: { beta: true }');
    expect(d.text.startsWith('// UAT\n')).toBe(true);
    expect(d.placeholders).toEqual(['PL_QA_UNAME', 'PL_QA_PASSWORD', 'PL_QA_KEY']);
  });

  it('listed mode: only the listed keys of the env project', () => {
    const d = deriveEnvFile(SOURCE, {
      env: 'qa',
      app: 'pl',
      envProject: 'pl',
      cfg: cfg({ mode: 'listed', keys: { default: ['uname'], pl: ['password'] } }),
    });
    expect(d.placeholders).toEqual(['PL_QA_PASSWORD']);
    expect(d.text).toContain('uname: "uat-user"');
  });

  it('sets the api url and the production flag when given', () => {
    const d = deriveEnvFile(SOURCE, {
      env: 'sit',
      app: 'field-ops',
      envProject: 'field-ops',
      cfg: cfg({}),
      apiUrl: 'https://sit.example.com/api',
      production: true,
    });
    expect(d.text).toContain("apiBaseUrl: 'https://sit.example.com/api'");
    expect(d.text).toContain('production: true,');
    expect(d.set).toEqual(['envName', 'apiBaseUrl', 'production']);
  });

  it('names placeholders APP_ENV_KEY in upper snake case', () => {
    expect(placeholderName('field-ops', 'pre-prod', 'apiSecretKey')).toBe(
      'FIELD_OPS_PRE_PROD_API_SECRET_KEY',
    );
  });
});

describe('deriveFlutterEnv', () => {
  it('sets env name fields and the api url', () => {
    expect(
      deriveFlutterEnv(
        { FLUTTER_ENV: 'uat', API_BASE_URL: 'https://uat.example.com', FEATURE_X: true },
        'qa',
        'https://qa.example.com',
      ),
    ).toEqual({ FLUTTER_ENV: 'qa', API_BASE_URL: 'https://qa.example.com', FEATURE_X: true });
  });
});

describe('deriveEnvFile edge cases', () => {
  const base = defaultEnvEncryptionConfig();
  it('replaces production written as an expression and notes missing fields', () => {
    const d = deriveEnvFile("export const environment = { production: !0, envName: 'uat' };\n", {
      env: 'qa',
      app: 'pl',
      envProject: 'pl',
      cfg: base,
      production: false,
    });
    expect(d.text).toContain('production: false,');
    const e = deriveEnvFile("export const environment = { name: 'x' };\n", {
      env: 'qa',
      app: 'pl',
      envProject: 'pl',
      cfg: base,
      production: true,
      apiUrl: 'https://qa.example.com',
    });
    expect(e.notes).toEqual([
      'no top-level `production` field; --production was not applied',
      'no `envName` field to set',
      'no api url field (apiBaseUrl, apiUrl, …) for --api-url',
    ]);
  });

  it('only replaces api base url keys', () => {
    const d = deriveEnvFile(
      "export const environment = { apiBaseUrl: 'https://a', mapsApiUrl: 'https://maps', API_BASE_URL: 'https://b' };\n",
      { env: 'qa', app: 'pl', envProject: 'pl', cfg: base, apiUrl: 'https://qa' },
    );
    expect(d.text).toContain("apiBaseUrl: 'https://qa'");
    expect(d.text).toContain("API_BASE_URL: 'https://qa'");
    expect(d.text).toContain("mapsApiUrl: 'https://maps'");
  });

  it('notes nested listed keys it copied, and copies everything with placeholders off', () => {
    const src = "export const environment = { password: 'p', auth: { clientSecret: 's' } };\n";
    const cfg = {
      ...base,
      mode: 'listed' as const,
      keys: { default: ['password', 'clientSecret'] },
    };
    const d = deriveEnvFile(src, { env: 'qa', app: 'pl', envProject: 'pl', cfg });
    expect(d.text).toContain("password: '${PL_QA_PASSWORD}'");
    expect(d.notes).toContain('nested clientSecret copied as is from the source file; change them');
    const off = deriveEnvFile(src, {
      env: 'qa',
      app: 'pl',
      envProject: 'pl',
      cfg,
      placeholders: false,
    });
    expect(off.text).toContain("password: 'p'");
    expect(off.placeholders).toEqual([]);
  });

  it('all mode keeps plain settings and existing placeholders become env-specific', () => {
    const d = deriveEnvFile(
      "export const environment = { appName: 'Shop', defaultLang: 'en', token: 't', mapKey: '${MAPS}' };\n",
      { env: 'qa', app: 'shop', envProject: 'shop', cfg: { ...base, mode: 'all' } },
    );
    expect(d.text).toContain("appName: 'Shop'");
    expect(d.text).toContain("defaultLang: 'en'");
    expect(d.text).toContain("token: '${SHOP_QA_TOKEN}'");
    expect(d.text).toContain("mapKey: '${SHOP_QA_MAP_KEY}'");
  });
});
