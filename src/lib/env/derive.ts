import { EnvEncryptionConfig, listedKeys } from '../env-encryption/config';
import { plainKeys, setStringFields } from '../env-encryption/encrypt';
import { environmentFields, scanEnvironment } from '../env-encryption/env-file';
import { isSensitiveKey } from '../env-encryption/sensitive';

export interface DeriveOptions {
  /** New environment name, e.g. qa. */
  env: string;
  /** App name: part of the placeholder names. */
  app: string;
  /** Env project (folder under environments/), for listed-mode keys. */
  envProject: string;
  cfg: EnvEncryptionConfig;
  /** Replaces http(s) values of fields whose key mentions "api" (e.g. apiBaseUrl). */
  apiUrl?: string;
  /** Sets a `production: true|false` field. */
  production?: boolean;
  /** Turn secret values into placeholders (default true); false copies them. */
  placeholders?: boolean;
}

export interface Derived {
  text: string;
  /** Placeholder names written for secret fields, e.g. PL_QA_PASSWORD. */
  placeholders: string[];
  /** Fields set to new values (envName, api urls, production). */
  set: string[];
  /** Things the caller should tell the user (values copied as is, fields not found). */
  notes: string[];
}

/** Keys holding the API base URL (apiBaseUrl, apiUrl, baseApiUrl, API_BASE_URL, apiEndpoint…). */
export function isApiUrlKey(key: string): boolean {
  return /^(api(base)?(url|uri|endpoint)|base(api)?url)$/i.test(key.replace(/[_-]/g, ''));
}

const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

/** `${<APP>_<ENV>_<KEY>}` name for a secret field. */
export function placeholderName(app: string, env: string, key: string): string {
  return `${snake(app)}_${snake(env)}_${snake(key)}`;
}

const URL_LIKE = /^https?:\/\//i;
const PLACEHOLDER_ONLY = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * A new env file from an existing one: the same fields, `envName` set to the new env, api urls
 * replaced when given, and every field env encryption treats as secret (listed keys, or in
 * `all` mode every string field except publicKeys and the build stamp) turned into a
 * `${APP_ENV_KEY}` placeholder that the build fills from CI or .env.local. URL values are copied.
 */
export function deriveEnvFile(source: string, o: DeriveOptions): Derived {
  const fields = environmentFields(source);
  const stamp = new Set([o.cfg.stamp?.timeField, o.cfg.stamp?.branchField].filter(Boolean));
  const listed = new Set(listedKeys(o.cfg, o.envProject));
  const plain = plainKeys(o.cfg);
  // listed: the listed keys. all: non-public string fields that look sensitive (password, token,
  // key, …) or already hold a placeholder; plain settings (appName, defaultLang) are copied.
  const secret = (key: string, value: string) =>
    o.cfg.mode === 'listed'
      ? listed.has(key)
      : !plain.has(key) && !stamp.has(key) && (isSensitiveKey(key) || PLACEHOLDER_ONLY.test(value));
  const usePlaceholders = o.placeholders ?? true;
  const notes: string[] = [];
  if (!scanEnvironment(source).found) {
    notes.push('no `environment = { … }` object found; the file was copied unchanged');
  }

  const values: Record<string, string> = {};
  const placeholders: string[] = [];
  const set: string[] = [];
  for (const f of fields) {
    if (f.kind !== 'string') continue;
    const current = f.text ?? '';
    if (f.key === 'envName') {
      values[f.key] = o.env;
      set.push(f.key);
    } else if (o.apiUrl && isApiUrlKey(f.key) && URL_LIKE.test(current)) {
      values[f.key] = o.apiUrl;
      set.push(f.key);
    } else if (
      usePlaceholders &&
      secret(f.key, current) &&
      current !== '' &&
      !URL_LIKE.test(current)
    ) {
      const name = placeholderName(o.app, o.env, f.key);
      values[f.key] = `\${${name}}`;
      placeholders.push(name);
    }
  }
  let { text } = setStringFields(source, values);

  if (o.production !== undefined) {
    // Any value (true, !0, Boolean(…)) is replaced by the literal.
    const prod = environmentFields(text).find((f) => f.key === 'production');
    if (prod) {
      text = text.slice(0, prod.start) + String(o.production) + text.slice(prod.end);
      set.push('production');
    } else {
      notes.push('no top-level `production` field; --production was not applied');
    }
  }
  if (fields.length > 0 && !set.includes('envName')) notes.push('no `envName` field to set');
  if (o.apiUrl && !fields.some((f) => isApiUrlKey(f.key))) {
    notes.push('no api url field (apiBaseUrl, apiUrl, …) for --api-url');
  }
  if (usePlaceholders && o.cfg.mode === 'listed') {
    // Listed keys deeper in the file (e.g. auth.clientSecret) are encrypted but not replaced here.
    const top = new Set(fields.map((f) => f.key));
    const nested = [...listed].filter(
      (k) =>
        !top.has(k) &&
        new RegExp(`(?<![\\w$])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(source),
    );
    if (nested.length > 0) {
      notes.push(`nested ${nested.join(', ')} copied as is from the source file; change them`);
    }
  }
  return { text, placeholders, set, notes };
}

/** A Flutter env/<env>.json from an existing one: env name fields and the api url updated. */
export function deriveFlutterEnv(
  source: Record<string, unknown>,
  env: string,
  apiUrl?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...source };
  for (const key of Object.keys(out)) {
    if (/^(FLUTTER_ENV|ENV_NAME|ENV|APP_ENV)$/i.test(key)) out[key] = env;
    else if (
      apiUrl &&
      isApiUrlKey(key) &&
      typeof out[key] === 'string' &&
      URL_LIKE.test(out[key] as string)
    ) {
      out[key] = apiUrl;
    }
  }
  return out;
}
