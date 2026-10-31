import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrateGenerator from '../../../src/generators/migrate/generator';

import { fixtureCopy, put, putJson, readJsonFile } from './helpers';

const CLEAN_IMAGES = `const fs = require('fs');
const sharp = require('sharp');
const DIRS = ['libs/assets'];
for (const dir of DIRS) {
  for (const f of fs.readdirSync(dir).filter((n) => /\\.(jpe?g|png)$/i.test(n))) {
    sharp(dir + '/' + f).rotate().toBuffer().then((b) => fs.writeFileSync(dir + '/' + f, b)); // drop EXIF
  }
}
`;
const CHECK = `const { execSync } = require('child_process');
const fs = require('fs');
for (const app of fs.readdirSync('apps')) {
  execSync('npx tsc --noEmit -p apps/' + app + '/tsconfig.app.json');
}
`;

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({ name: '@acme/workspace', scripts: { lint: 'nx run-many -t lint' } }),
  );
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  return tree;
}

describe('migrate: source scripts pstack does now (NX-110, NX-111)', () => {
  let tree: Tree;
  let src: string;

  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    src = fixtureCopy('nx15-multi-app');
    put(src, 'tools/scripts/clean-images.js', CLEAN_IMAGES);
    put(src, 'tools/scripts/check.js', CHECK);
    const pkg = readJsonFile<{ scripts: Record<string, string> }>(src, 'package.json');
    pkg.scripts['assets:strip-exif'] = 'node tools/scripts/clean-images.js';
    pkg.scripts['validate:imports'] = 'node tools/scripts/check.js';
    putJson(src, 'package.json', pkg);
    tree = workspace();
  });
  afterEach(() => jest.restoreAllMocks());

  it('points the copied npm scripts at pstack and does not copy the scripts', async () => {
    await migrateGenerator(tree, { source: src, name: 'multi' });
    const scripts = readJson(tree, 'package.json').scripts;
    expect(scripts['assets:strip-exif']).toMatch(
      /^pstack assets strip-exif --(?:all|app=admin,portal)$/,
    );
    expect(scripts['validate:imports']).toMatch(/^nx run-many -t typecheck\b/);
    expect(tree.exists('tools/scripts/clean-images.js')).toBe(false);
    expect(tree.exists('tools/scripts/check.js')).toBe(false);
    // Only a comment that mentions tsc: not a type-check script, copied as any other file.
    expect(tree.exists('tools/scripts/validate-types.js')).toBe(true);
    expect(tree.exists('tools/scripts/build.js')).toBe(true);
    const report = tree.read('docs/migrations/multi.md', 'utf8') ?? '';
    expect(report).toContain(
      '`tools/scripts/clean-images.js` (EXIF in source images) was not copied',
    );
    expect(report).not.toContain('validate-types.js` (type checking)');
    // The apps were given what the new commands run.
    expect(readJson(tree, 'apps/portal/project.json').targets.typecheck).toBeDefined();
  });

  it('--keep-old-scripts copies them as before', async () => {
    await migrateGenerator(tree, { source: src, name: 'multi', keepOldScripts: true });
    expect(readJson(tree, 'package.json').scripts['validate:imports']).toBe(
      'node tools/scripts/check.js',
    );
    expect(tree.exists('tools/scripts/clean-images.js')).toBe(true);
  });

  it('rollback removes what the run wrote', async () => {
    const before = tree.read('package.json', 'utf8');
    await migrateGenerator(tree, { source: src, name: 'multi' });
    await migrateGenerator(tree, { rollback: 'multi' });
    expect(tree.read('package.json', 'utf8')).toBe(before);
    expect(tree.exists('tools/scripts/build.js')).toBe(false);
  });
});
