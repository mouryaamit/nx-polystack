import { parseDir, upTo } from '../../../src/generators/migrate/names';

describe('parseDir', () => {
  it('accepts kebab-case segments', () => {
    expect(parseDir(undefined)).toBeUndefined();
    expect(parseDir('legacy')).toBe('legacy');
    expect(parseDir('legacy/web')).toBe('legacy/web');
  });

  it.each(['', '/legacy', 'legacy/', 'Legacy', '../x', 'a//b', 'a/./b', 'a b'])(
    'refuses %j',
    (v) => {
      expect(() => parseDir(v)).toThrow('must be kebab-case folder names separated by "/"');
    },
  );

  it('caps the depth and refuses git-ignored names', () => {
    expect(parseDir('a/b/c')).toBe('a/b/c');
    expect(() => parseDir('a/b/c/d')).toThrow('is too deep: at most 3 folders');
    expect(() => parseDir('legacy/dist')).toThrow(
      'uses "dist", which the workspace .gitignore hides',
    );
  });

  it('upTo climbs one level per segment', () => {
    expect(upTo('apps/portal')).toBe('../../');
    expect(upTo('apps/legacy/portal')).toBe('../../../');
  });
});

describe('parseDir label', () => {
  it('starts the message with the caller', () => {
    expect(() => parseDir('Bad', 'app generator')).toThrow('app generator: --dir="Bad"');
  });
});
