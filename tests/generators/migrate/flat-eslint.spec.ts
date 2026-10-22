import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import {
  eslintrcForFlatConfig,
  FLAT_ESLINT_FILE,
  FLAT_ESLINT_PACKAGE,
  workspaceUsesEslintrc,
} from '../../../src/generators/migrate/nx/flat-eslint';

describe('flat ESLint config in an .eslintrc workspace', () => {
  it('recognises flat config files and packages', () => {
    for (const f of ['eslint.config.js', 'apps/a/eslint.config.mjs', 'eslint.base.config.cjs']) {
      expect(FLAT_ESLINT_FILE.test(f)).toBe(true);
    }
    expect(FLAT_ESLINT_FILE.test('apps/a/.eslintrc.json')).toBe(false);
    expect(FLAT_ESLINT_PACKAGE.test('typescript-eslint')).toBe(true);
    expect(FLAT_ESLINT_PACKAGE.test('@typescript-eslint/parser')).toBe(false);
  });

  it('reads the workspace format from the root config', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(workspaceUsesEslintrc(tree)).toBe(true);
    tree.write('eslint.config.mjs', 'export default [];\n');
    expect(workspaceUsesEslintrc(tree)).toBe(false);
  });

  it('writes the TypeScript overrides for a non-Angular project', () => {
    const rc = eslintrcForFlatConfig(
      "module.exports = [...require('../../eslint.config.js')];",
      'libs/shared/util',
    );
    expect(rc['extends']).toEqual(['../../../.eslintrc.json']);
    expect(rc['overrides']).toEqual([
      { files: ['*.ts', '*.tsx', '*.js', '*.jsx'], rules: {} },
      { files: ['*.ts', '*.tsx'], rules: {} },
      { files: ['*.js', '*.jsx'], rules: {} },
    ]);
  });

  it('leaves the selector rules out when their prefix is not a plain string', () => {
    const rc = eslintrcForFlatConfig(
      "nx.configs['flat/angular']; '@angular-eslint/component-selector': ['error', { prefix: PREFIX }]",
      'apps/a',
    );
    const overrides = rc['overrides'] as { rules: Record<string, unknown> }[];
    expect(overrides[0].rules).toEqual({});
  });
});
