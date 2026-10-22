import { Tree } from '@nx/devkit';

/** ESLint flat config files (eslint.config.js and Nx's eslint.base.config.js, any JS flavour). */
export const FLAT_ESLINT_FILE = /(^|\/)eslint(\.base)?\.config\.[cm]?js$/;

/**
 * Packages that only a flat-config (ESLint 9) setup needs. A workspace on .eslintrc.json keeps
 * ESLint 8 with typescript-eslint 5/7, and these would mix majors (typescript-eslint 8 rules
 * crash under ESLint 8).
 */
export const FLAT_ESLINT_PACKAGE =
  /^(typescript-eslint|angular-eslint|@eslint\/js|@eslint\/eslintrc|@typescript-eslint\/utils)$/;

/** The workspace lints with .eslintrc.json: it has no root flat config. */
export function workspaceUsesEslintrc(tree: Tree): boolean {
  return !['eslint.config.js', 'eslint.config.cjs', 'eslint.config.mjs'].some((f) =>
    tree.exists(f),
  );
}

/** The `prefix` of a selector rule in a flat config's text, if it is a plain string literal. */
function selectorPrefix(text: string, rule: string): string | undefined {
  const at = text.indexOf(rule);
  if (at === -1) return undefined;
  const m = /prefix\s*:\s*['"]([A-Za-z][\w-]*)['"]/.exec(text.slice(at, at + 400));
  return m?.[1];
}

/**
 * The .eslintrc.json Nx writes for a project, standing in for its flat eslint.config.js: Angular
 * projects (the config uses Nx's flat/angular presets) get the Angular overrides with the
 * selector prefixes of the flat config, others the TypeScript/JavaScript override.
 */
export function eslintrcForFlatConfig(text: string, root: string): Record<string, unknown> {
  const up = '../'.repeat(root.split('/').filter(Boolean).length);
  const base = { extends: [`${up}.eslintrc.json`], ignorePatterns: ['!**/*'] };
  if (!/flat\/angular/.test(text)) {
    return {
      ...base,
      overrides: [
        { files: ['*.ts', '*.tsx', '*.js', '*.jsx'], rules: {} },
        { files: ['*.ts', '*.tsx'], rules: {} },
        { files: ['*.js', '*.jsx'], rules: {} },
      ],
    };
  }
  const directive = selectorPrefix(text, '@angular-eslint/directive-selector');
  const component = selectorPrefix(text, '@angular-eslint/component-selector');
  const rules: Record<string, unknown> = {};
  if (directive) {
    rules['@angular-eslint/directive-selector'] = [
      'error',
      { type: 'attribute', prefix: directive, style: 'camelCase' },
    ];
  }
  if (component) {
    rules['@angular-eslint/component-selector'] = [
      'error',
      { type: 'element', prefix: component, style: 'kebab-case' },
    ];
  }
  return {
    ...base,
    overrides: [
      {
        files: ['*.ts'],
        extends: ['plugin:@nx/angular', 'plugin:@angular-eslint/template/process-inline-templates'],
        rules,
      },
      { files: ['*.html'], extends: ['plugin:@nx/angular-template'], rules: {} },
    ],
  };
}
