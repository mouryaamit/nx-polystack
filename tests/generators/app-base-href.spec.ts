import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import appGenerator from '../../src/generators/app/generator';

describe('app generator --baseHref', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: {}, dependencies: {} }));
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  const configs = (target: string, name: string) =>
    JSON.parse(tree.read(`apps/${name}/project.json`, 'utf-8') as string).targets[target]
      .configurations;

  it.each(['angular', 'ionic'] as const)(
    '%s: sets baseHref on the uat and prod release configurations only',
    async (type) => {
      await appGenerator(tree, { name: 'portal', type, baseHref: '/portal/' });
      const c = configs('release', 'portal');
      expect(c.uat.baseHref).toBe('/portal/');
      expect(c.prod.baseHref).toBe('/portal/');
      expect(c.dev.baseHref).toBeUndefined();
    },
  );

  it('flutter: sets baseHref on build-web uat and prod', async () => {
    await appGenerator(tree, { name: 'mobile', type: 'flutter', baseHref: '/m/' });
    const c = configs('build-web', 'mobile');
    expect([c.dev.baseHref, c.uat.baseHref, c.prod.baseHref]).toEqual([undefined, '/m/', '/m/']);
  });

  it('leaves the configurations alone without baseHref', async () => {
    await appGenerator(tree, { name: 'portal', type: 'angular' });
    expect(configs('release', 'portal').uat.baseHref).toBeUndefined();
  });

  it.each([
    'portal/',
    '/portal',
    '/a b/',
    '',
    '//evil.com/',
    '/a$(id)/',
    '/a`id`/',
    '/a&b/',
    '/a?x/',
    '/a#/',
    '/a\\b/',
    '/a/../b/',
  ])('rejects "%s"', async (href) => {
    await expect(
      appGenerator(tree, { name: 'portal', type: 'angular', baseHref: href }),
    ).rejects.toThrow('must start and end with "/"');
    expect(tree.exists('apps/portal')).toBe(false);
  });

  it('accepts nested paths with URL-safe characters', async () => {
    await appGenerator(tree, { name: 'portal', type: 'angular', baseHref: '/pl/v1.2_x~y-%20/' });
    expect(configs('release', 'portal').uat.baseHref).toBe('/pl/v1.2_x~y-%20/');
  });

  it('accepts the root /', async () => {
    await appGenerator(tree, { name: 'portal', type: 'angular', baseHref: '/' });
    expect(configs('release', 'portal').prod.baseHref).toBe('/');
  });
});
