import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { generateAngularEnvFiles, generateFlutterEnvFiles } from '../../src/lib/utils/env-files';

describe('generateAngularEnvFiles', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  });

  it('creates environment.ts, environment.uat.ts, environment.prod.ts', () => {
    generateAngularEnvFiles(tree, 'web');
    expect(tree.exists('environments/web/environment.ts')).toBe(true);
    expect(tree.exists('environments/web/environment.uat.ts')).toBe(true);
    expect(tree.exists('environments/web/environment.prod.ts')).toBe(true);
  });

  it('emits production:true only in environment.prod.ts', () => {
    generateAngularEnvFiles(tree, 'web');
    expect(tree.read('environments/web/environment.ts')!.toString()).toContain('production: false');
    expect(tree.read('environments/web/environment.uat.ts')!.toString()).toContain(
      'production: false',
    );
    expect(tree.read('environments/web/environment.prod.ts')!.toString()).toContain(
      'production: true',
    );
  });
});

describe('generateFlutterEnvFiles', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  });

  it('creates dev.json, uat.json, prod.json under apps/<name>/env/', () => {
    generateFlutterEnvFiles(tree, 'flutter-app');
    expect(tree.exists('apps/flutter-app/env/dev.json')).toBe(true);
    expect(tree.exists('apps/flutter-app/env/uat.json')).toBe(true);
    expect(tree.exists('apps/flutter-app/env/prod.json')).toBe(true);
  });

  it('emits valid JSON with FLUTTER_ENV key', () => {
    generateFlutterEnvFiles(tree, 'flutter-app');
    const dev = JSON.parse(tree.read('apps/flutter-app/env/dev.json')!.toString());
    expect(dev.FLUTTER_ENV).toBe('dev');
  });
});
