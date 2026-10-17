type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const TS_EXTENDS = [
  'plugin:@nx/angular',
  'plugin:@angular-eslint/template/process-inline-templates',
];
const HTML_EXTENDS = ['plugin:@nx/angular-template'];

const filesOf = (override: Json): string[] => {
  const files = override['files'];
  return Array.isArray(files) ? files.map(String) : typeof files === 'string' ? [files] : [];
};

/**
 * An Angular CLI sub-project's .eslintrc.json only has rule overrides; the parser and the Angular
 * rule sets came from the source root config, which the workspace root does not have. Overrides
 * for *.ts and *.html without `extends` get the ones `pstack app` uses.
 */
export function withAngularLintExtends(config: Json): Json {
  const overrides = config['overrides'];
  if (!Array.isArray(overrides)) return config;
  return {
    ...config,
    overrides: overrides.map((o) => {
      if (!isObject(o) || o['extends'] !== undefined) return o;
      const files = filesOf(o);
      if (files.some((f) => /\*\.ts$/.test(f))) return { ...o, extends: TS_EXTENDS };
      if (files.some((f) => /\*\.html$/.test(f))) return { ...o, extends: HTML_EXTENDS };
      return o;
    }),
  };
}
