import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import libGenerator from '../../src/generators/lib/generator';

describe('lib generator --type=assets / styles', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
    );
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it('assets: project.json without targets, .gitkeep and a README with the app assets entry', async () => {
    const cb = await libGenerator(tree, { name: 'brand', type: 'assets' });
    const root = 'libs/shared/brand';
    const pj = readJson(tree, `${root}/project.json`);
    expect(pj.name).toBe('shared-brand');
    expect(pj.projectType).toBe('library');
    expect(pj.targets).toEqual({});
    expect(pj.tags).toEqual(['scope:shared', 'type:assets', 'platform:any']);
    expect(tree.exists(`${root}/assets/.gitkeep`)).toBe(true);
    const readme = tree.read(`${root}/README.md`, 'utf8') ?? '';
    const block = /```json\n([\s\S]*?)```/.exec(readme);
    expect(JSON.parse(block?.[1] ?? 'null')).toEqual({
      glob: '**/*',
      input: 'libs/shared/brand/assets',
      output: 'assets/brand',
    });
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual({});
    expect(cb).toBeUndefined();
  });

  it('styles: tokens, themes and mixins forwarded from src/_index.scss', async () => {
    const cb = await libGenerator(tree, { name: 'theme', type: 'styles', scope: 'web' });
    const root = 'libs/web/theme';
    const pj = readJson(tree, `${root}/project.json`);
    expect(pj.name).toBe('web-theme');
    expect(pj.targets).toEqual({});
    expect(pj.tags).toEqual(['scope:web', 'type:styles', 'platform:web']);
    const index = tree.read(`${root}/src/_index.scss`, 'utf8') ?? '';
    for (const part of ['tokens', 'themes', 'mixins']) {
      expect(index).toContain(`@forward '${part}';`);
      expect(tree.exists(`${root}/src/${part}/_index.scss`)).toBe(true);
    }
    expect(tree.read(`${root}/src/tokens/_index.scss`, 'utf8')).toContain('$color-primary:');
    expect(tree.read(`${root}/src/themes/_index.scss`, 'utf8')).toContain('@mixin theme-dark');
    expect(tree.read(`${root}/src/mixins/_index.scss`, 'utf8')).toContain(
      '@mixin breakpoint-up($name)',
    );
    const readme = tree.read(`${root}/README.md`, 'utf8') ?? '';
    expect(readme).toMatch(/"includePaths": \[\s*"libs\/web\/theme\/src"\s*\]/);
    expect(readme).toContain("@use 'index' as theme;");
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual({});
    expect(cb).toBeUndefined();
  });
});
