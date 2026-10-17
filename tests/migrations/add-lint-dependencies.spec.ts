import { readJson, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import addLintDependencies from '../../src/migrations/add-lint-dependencies/add-lint-dependencies';

const LINT = {
  eslint: '^8.57.0',
  '@nx/eslint': '17.0.6',
  '@nx/eslint-plugin': '17.0.6',
  '@typescript-eslint/eslint-plugin': '^5.62.0',
  '@typescript-eslint/parser': '^5.62.0',
  'eslint-config-prettier': '^9.1.0',
};

function tree(deps: Record<string, string>, devDeps: Record<string, string>) {
  const t = createTreeWithEmptyWorkspace();
  updateJson(t, 'package.json', (j) => ({ ...j, dependencies: deps, devDependencies: devDeps }));
  return t;
}

describe('add-lint-dependencies migration', () => {
  it('adds the ESLint stack to a workspace without Angular, and no Angular packages', async () => {
    const t = tree({}, { nx: '17.0.6' });
    const cb = await addLintDependencies(t);
    const pkg = readJson(t, 'package.json');
    expect(pkg.devDependencies).toMatchObject(LINT);
    expect(pkg.dependencies['@angular/core']).toBeUndefined();
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBeUndefined();
    expect(typeof cb).toBe('function');
  });

  it('adds missing Angular lint packages to an Angular 15 workspace', async () => {
    const t = tree({ '@angular/core': '~15.2.0' }, { nx: '17.0.6', ...LINT });
    await addLintDependencies(t);
    const dev = readJson(t, 'package.json').devDependencies;
    expect(dev['@nx/angular']).toBe('17.0.6');
    expect(dev['@angular-eslint/eslint-plugin']).toBe('~15.2.0');
    expect(dev['@angular-eslint/template-parser']).toBe('~15.2.0');
  });

  it('is a no-op when everything is already declared', async () => {
    const t = tree({}, { nx: '17.0.6', ...LINT });
    const before = readJson(t, 'package.json');
    expect(await addLintDependencies(t)).toBeUndefined();
    expect(readJson(t, 'package.json')).toEqual(before);
  });
});
