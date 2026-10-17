import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import libGenerator from '../../src/generators/lib/generator';
import type { LibType } from '../../src/generators/lib/schema';
import { workspaceProjectNames } from '../../src/lib/utils/llm-block';

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
  );
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  return tree;
}

/** Every file under `dir`, recursively. */
function files(tree: Tree, dir: string): string[] {
  return tree.children(dir).flatMap((c) => {
    const p = `${dir}/${c}`;
    return tree.isFile(p) ? [p] : files(tree, p);
  });
}

/** "../" runs in front of workspace-root targets, as counts of "../". */
function rootOffsets(tree: Tree, root: string): number[] {
  const re = /((?:\.\.\/)+)(tsconfig\.base\.json|\.eslintrc\.json|node_modules\/|dist\/)/g;
  return files(tree, root).flatMap((f) =>
    [...(tree.read(f, 'utf8') ?? '').matchAll(re)].map((m) => m[1].length / 3),
  );
}

const TYPES: [LibType, string, string][] = [
  ['ts', 'shared', 'util'],
  ['angular', 'shared', 'ui'],
  ['ionic', 'ionic', 'ui'],
  ['flutter', 'flutter', 'core_kit'],
  ['assets', 'shared', 'images'],
  ['styles', 'shared', 'theme'],
  ['state', 'shared', 'orders'],
  ['design-tokens', 'shared', 'brand'],
];

describe('lib generator --dir', () => {
  it.each(TYPES)(
    '--type=%s goes to libs/<scope>/<dir>/<name> with depth-aware paths',
    async (type, scope, folder) => {
      const tree = workspace();
      const name = folder.replace(/_/g, '-');
      await libGenerator(tree, { name, type, dir: 'forms/inner' });
      const root = `libs/${scope}/forms/inner/${folder}`;
      expect(tree.exists(`libs/${scope}/${folder}`)).toBe(false);
      const pj = readJson(tree, `${root}/project.json`);
      expect(pj.name).toBe(`${scope}-${name}`);
      expect(pj.$schema).toBe('../../../../../node_modules/nx/schemas/project-schema.json');
      const offsets = rootOffsets(tree, root);
      expect(offsets.length).toBeGreaterThan(0);
      expect(offsets.every((n) => n === 5)).toBe(true);
    },
  );

  it('keeps the project name and import alias', async () => {
    const tree = workspace();
    await libGenerator(tree, { name: 'ui', type: 'angular', variant: 'publishable', dir: 'forms' });
    const root = 'libs/shared/forms/ui';
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/shared-ui']).toEqual([
      `${root}/src/index.ts`,
    ]);
    expect(readJson(tree, `${root}/ng-package.json`).dest).toBe(
      '../../../../dist/libs/shared/forms/ui',
    );
    expect(readJson(tree, `${root}/project.json`).tags).toContain('scope:shared');
  });

  it.each([
    ['a/b/c', 'is too deep: at most 2 folders'],
    ['Forms', 'must be kebab-case folder names'],
    ['forms/dist', 'uses "dist"'],
  ])('refuses --dir=%j', async (dir, message) => {
    await expect(libGenerator(workspace(), { name: 'ui', type: 'ts', dir })).rejects.toThrow(
      `lib generator: --dir="${dir}" ${message}`,
    );
  });

  it('refuses a dir through another library and a name taken in another folder', async () => {
    const tree = workspace();
    await libGenerator(tree, { name: 'forms', type: 'ts' });
    await expect(libGenerator(tree, { name: 'ui', type: 'ts', dir: 'forms' })).rejects.toThrow(
      'lib generator: --dir="forms" goes through the project in "libs/shared/forms"',
    );
    await libGenerator(tree, { name: 'ui', type: 'ts', dir: 'admin' });
    await expect(libGenerator(tree, { name: 'ui', type: 'ts', dir: 'other' })).rejects.toThrow(
      'a project named "shared-ui" already exists',
    );
  });

  it('is found by the workspace scans at the 2-folder limit', async () => {
    const tree = workspace();
    await libGenerator(tree, { name: 'deep', type: 'ts', dir: 'a/b' });
    expect(workspaceProjectNames(tree)).toContain('shared-deep');
    await expect(libGenerator(tree, { name: 'deep', type: 'ts', dir: 'c/d' })).rejects.toThrow(
      'a project named "shared-deep" already exists',
    );
  });

  it('refuses a dir through a Flutter library and an empty dir', async () => {
    const tree = workspace();
    await libGenerator(tree, { name: 'core', type: 'flutter' });
    await expect(libGenerator(tree, { name: 'kit', type: 'flutter', dir: 'core' })).rejects.toThrow(
      'goes through the project in "libs/flutter/core"',
    );
    await expect(libGenerator(tree, { name: 'kit', type: 'ts', dir: '' })).rejects.toThrow(
      'must be kebab-case folder names',
    );
  });

  it('refuses a scope folder that is itself a project, with or without --dir', async () => {
    const tree = workspace();
    tree.write('libs/shared/project.json', JSON.stringify({ name: 'shared' }));
    for (const dir of [undefined, 'forms']) {
      await expect(libGenerator(tree, { name: 'ui', type: 'ts', dir })).rejects.toThrow(
        'lib generator: "libs/shared" is a project',
      );
    }
  });

  it('says why a folder holding nested libraries cannot be a library', async () => {
    const tree = workspace();
    await libGenerator(tree, { name: 'ui', type: 'ts', dir: 'forms' });
    await expect(libGenerator(tree, { name: 'forms', type: 'ts' })).rejects.toThrow(
      '"libs/shared/forms" already exists (it holds other libraries)',
    );
  });

  it('design-tokens build paths follow the nested root', async () => {
    const tree = workspace();
    await libGenerator(tree, { name: 'brand', type: 'design-tokens', dir: 'tokens' });
    const root = 'libs/shared/tokens/brand';
    expect(tree.read(`${root}/style-dictionary.config.js`, 'utf8')).toContain(`'${root}'`);
    expect(readJson(tree, `${root}/project.json`).targets.build.options.command).toContain(root);
  });
});
