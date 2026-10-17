import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { addKnipIgnores, formatKnipJson } from '../../src/lib/utils/knip';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prettier: { format(s: string, o: object): string } = require('prettier');
const pretty = (s: string) => prettier.format(s, { parser: 'json', printWidth: 100 });

describe('knip.json helpers', () => {
  it('formatKnipJson prints what Prettier prints (short arrays inline, long ones split)', () => {
    const long = Array.from({ length: 6 }, (_, i) => `libs/shared/tokens-${i}/generated/**`);
    const text = formatKnipJson({ $schema: 'x', entry: ['a', 'b'], ignore: long, empty: [] });
    expect(pretty(text)).toBe(text);
    expect(text).toContain('"entry": ["a", "b"],');
    expect(text).toContain('"ignore": [\n    "libs/shared/tokens-0/generated/**",');
  });

  it('adds ignores to an existing knip.json, deduped, creating the array if needed', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('knip.json', '{\n  "entry": ["apps/*/src/main.ts"]\n}\n');
    expect(addKnipIgnores(tree, ['libs/a/generated/**', 'libs/a/src/lib/tokens.ts'])).toBe(true);
    expect(addKnipIgnores(tree, ['libs/a/generated/**', 'libs/b/generated/**'])).toBe(true);
    expect(addKnipIgnores(tree, ['libs/b/generated/**'])).toBe(false);
    const text = tree.read('knip.json', 'utf8') ?? '';
    expect(JSON.parse(text)).toEqual({
      entry: ['apps/*/src/main.ts'],
      ignore: ['libs/a/generated/**', 'libs/a/src/lib/tokens.ts', 'libs/b/generated/**'],
    });
    expect(pretty(text)).toBe(text);
  });

  it('does nothing without knip.json, or when it cannot be read as an object', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(addKnipIgnores(tree, ['x'])).toBe(false);
    expect(tree.exists('knip.json')).toBe(false);
    tree.write('knip.json', '{ "ignore": "not-an-array" }');
    expect(addKnipIgnores(tree, ['x'])).toBe(false);
    tree.write('knip.json', '// comment\n{}');
    expect(addKnipIgnores(tree, ['x'])).toBe(false);
    expect(tree.read('knip.json', 'utf8')).toBe('// comment\n{}');
  });
});
