import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { buildProjectJson } from '../../src/generators/app/generator';
import { generateFlutterEnvFiles } from '../../src/lib/utils/env-files';

interface FlutterPj {
  name: string;
  $schema: string;
  sourceRoot: string;
  targets: Record<string, { options: Record<string, string> }>;
}

describe('Flutter project json and env files with a root', () => {
  it('uses apps/<name> by default', () => {
    const pj = buildProjectJson('mobile', { exportTarget: false }) as FlutterPj;
    expect(pj.sourceRoot).toBe('apps/mobile/lib');
    expect(pj.targets['build-web'].options.dist).toBe('dist/apps/mobile/web');
    expect(pj.$schema).toBe('../../node_modules/nx/schemas/project-schema.json');
  });

  it('follows another root', () => {
    const pj = buildProjectJson('acme-mobile', {
      exportTarget: true,
      root: 'apps/mobile/app',
    }) as FlutterPj;
    expect(pj.name).toBe('acme-mobile');
    expect(pj.sourceRoot).toBe('apps/mobile/app/lib');
    expect(pj.$schema).toBe('../../../node_modules/nx/schemas/project-schema.json');
    expect(pj.targets['build-web'].options.dist).toBe('dist/apps/mobile/app/web');
    expect(pj.targets.export.options.dest).toBe('apps/mobile/app');
  });

  it('writes env files under environments/<project>, wherever the app lives', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(generateFlutterEnvFiles(tree, 'x', { empty: true })).toEqual([
      'environments/x/environment.dev.json',
      'environments/x/environment.uat.json',
      'environments/x/environment.prod.json',
    ]);
  });
});
