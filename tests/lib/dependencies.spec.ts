import { readJson, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import {
  addMissingDependencies,
  ensureLintDependencies,
  majorOf,
} from '../../src/lib/utils/dependencies';

describe('majorOf', () => {
  it.each([
    ['~15.2.0', 15],
    ['^16.0.1', 16],
    ['15.2.10', 15],
    ['>=17.0.0', 17],
    ['v18.1.0', 18],
    ['15', 15],
    ['^15', 15],
    ['15.x', 15],
  ])('%s → %s', (v, major) => expect(majorOf(v)).toBe(major));

  it.each(['latest', '*', '', 'github:a/b'])('%s → undefined', (v) =>
    expect(majorOf(v)).toBeUndefined(),
  );
});

describe('addMissingDependencies', () => {
  it('adds only packages that are not declared anywhere and never overwrites', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.dependencies = { a: '1.0.0' };
      j.devDependencies = { b: '2.0.0' };
      return j;
    });
    const cb = addMissingDependencies(tree, { a: '9.9.9', c: '3.0.0' }, { b: '9.9.9', d: '4.0.0' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies).toEqual({ a: '1.0.0', c: '3.0.0' });
    expect(pkg.devDependencies).toEqual({ b: '2.0.0', d: '4.0.0' });
    expect(typeof cb).toBe('function');
  });

  it('returns undefined and leaves package.json alone when nothing is missing', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.dependencies = { a: '1.0.0' };
      return j;
    });
    const before = readJson(tree, 'package.json');
    expect(addMissingDependencies(tree, { a: '2.0.0' }, {})).toBeUndefined();
    expect(readJson(tree, 'package.json')).toEqual(before);
  });
});

describe('ensureLintDependencies', () => {
  it('prefers the nx version actually installed in node_modules', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.devDependencies = { nx: '^17.0.0' };
      return j;
    });
    tree.write('node_modules/nx/package.json', JSON.stringify({ name: 'nx', version: '17.0.6' }));
    ensureLintDependencies(tree);
    expect(readJson(tree, 'package.json').devDependencies['@nx/eslint']).toBe('17.0.6');
  });

  it('adds the ESLint stack, with Nx packages matching the installed nx', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.devDependencies = { nx: '17.0.6' };
      return j;
    });
    ensureLintDependencies(tree);
    const dev = readJson(tree, 'package.json').devDependencies;
    expect(dev).toMatchObject({
      eslint: '^8.57.0',
      '@nx/eslint': '17.0.6',
      '@nx/eslint-plugin': '17.0.6',
      '@typescript-eslint/eslint-plugin': '^5.62.0',
      '@typescript-eslint/parser': '^5.62.0',
      'eslint-config-prettier': '^9.1.0',
    });
  });

  it('is a no-op when everything is present', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.devDependencies = {
        nx: '17.0.6',
        eslint: '^8.0.0',
        '@nx/eslint': '17.0.6',
        '@nx/eslint-plugin': '17.0.6',
        '@typescript-eslint/eslint-plugin': '^5.0.0',
        '@typescript-eslint/parser': '^5.0.0',
        'eslint-config-prettier': '^9.0.0',
      };
      return j;
    });
    expect(ensureLintDependencies(tree)).toBeUndefined();
  });
});
