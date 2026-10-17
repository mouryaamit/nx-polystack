import { classifyDependencySpec, browserslistFile } from '../../../src/generators/migrate/npm-deps';

describe('migrate: npm dependency specs', () => {
  const ctx = { sourceDir: '/repo', copiedDir: '/repo', projectRoot: 'apps/portal' };

  it('leaves registry, git and URL specs alone', () => {
    for (const spec of [
      '^1.2.3',
      'latest',
      'npm:other@1',
      'github:me/x',
      'git+https://h/x.git',
      'https://h/x.tgz',
    ]) {
      expect([spec, classifyDependencySpec(spec, ctx)]).toEqual([spec, { kind: 'registry' }]);
    }
  });

  it('rebases file:, link: and relative paths inside the copied folder', () => {
    expect(classifyDependencySpec('file:libs/util', ctx)).toEqual({
      kind: 'rebased',
      spec: 'file:apps/portal/libs/util',
    });
    expect(classifyDependencySpec('link:./packages/ui', ctx)).toEqual({
      kind: 'rebased',
      spec: 'file:apps/portal/packages/ui',
    });
    expect(classifyDependencySpec('./vendor/x-1.0.0.tgz', ctx)).toEqual({
      kind: 'rebased',
      spec: 'file:apps/portal/vendor/x-1.0.0.tgz',
    });
    expect(classifyDependencySpec('file:.', ctx)).toEqual({
      kind: 'rebased',
      spec: 'file:apps/portal',
    });
  });

  it('holds back paths outside the copied folder', () => {
    expect(classifyDependencySpec('file:../shared', ctx)).toEqual({
      kind: 'outside',
      target: '/shared',
    });
    expect(classifyDependencySpec('../shared', ctx)).toEqual({
      kind: 'outside',
      target: '/shared',
    });
    expect(classifyDependencySpec('file:/opt/pkg', ctx)).toEqual({
      kind: 'outside',
      target: '/opt/pkg',
    });
    expect(
      classifyDependencySpec('file:libs/x', { ...ctx, copiedDir: '/repo/projects/shop' }),
    ).toEqual({ kind: 'outside', target: '/repo/libs/x' });
  });

  it('turns a package.json browserslist into a .browserslistrc', () => {
    expect(browserslistFile(['> 0.5%', 'last 2 versions', 'not dead'])).toBe(
      '> 0.5%\nlast 2 versions\nnot dead\n',
    );
    expect(browserslistFile('defaults')).toBe('defaults\n');
    expect(browserslistFile({ production: ['> 1%'], development: ['last 1 chrome version'] })).toBe(
      '[production]\n> 1%\n\n[development]\nlast 1 chrome version\n',
    );
    expect(browserslistFile(42)).toBeUndefined();
  });
});

describe('migrate: npm dependency specs with kept paths', () => {
  it('keeps the path when the files keep their place (projectRoot "")', () => {
    const ctx = { sourceDir: '/src', copiedDir: '/src', projectRoot: '' };
    expect(classifyDependencySpec('file:libs/tokens', ctx)).toEqual({
      kind: 'rebased',
      spec: 'file:libs/tokens',
    });
    expect(classifyDependencySpec('file:.', ctx)).toEqual({ kind: 'rebased', spec: 'file:.' });
  });
});
