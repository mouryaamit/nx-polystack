import * as path from 'path';

import { inferencePlugins } from '../../../src/generators/migrate/adapters/nx-workspace';
import { detectNxWorkspace } from '../../../src/generators/migrate/nx/detect';

import { FIXTURES, fixtureCopy, putJson } from './helpers';

describe('detectNxWorkspace', () => {
  it('is confident for Nx 15–17 with supported projects', () => {
    expect(detectNxWorkspace(fixtureCopy('nx16-workspace'))).toEqual({
      confidence: 0.95,
      reasons: [
        'nx.json, Nx 16.10.0',
        'projects: 2 angular-app, 1 e2e, 1 flutter-app, 1 flutter-lib, 1 ionic-app, 3 lib',
      ],
    });
  });

  it('is confident for Nx 18 to 22 too (Angular 17+ workspaces)', () => {
    const src = fixtureCopy('nx16-workspace');
    putJson(src, 'package.json', { devDependencies: { nx: '18.3.5' } });
    expect(detectNxWorkspace(src)).toMatchObject({ confidence: 0.95 });
    putJson(src, 'package.json', { devDependencies: { nx: '22.7.12' } });
    expect(detectNxWorkspace(src)).toMatchObject({ confidence: 0.95 });
  });

  it('lists the nx.json plugins that infer targets', () => {
    expect(inferencePlugins(undefined)).toEqual([]);
    expect(
      inferencePlugins({ plugins: ['@nx/eslint/plugin', { plugin: '@nx/jest/plugin' }, 3] }),
    ).toEqual(['@nx/eslint/plugin', '@nx/jest/plugin']);
  });

  it('is 0 without nx.json', () => {
    expect(detectNxWorkspace(path.join(FIXTURES, 'angular15-app'))).toEqual({
      confidence: 0,
      reasons: ['no nx.json'],
    });
  });

  it('drops to 0.5 for another Nx major and to 0.3 without supported projects', () => {
    const src = fixtureCopy('nx16-workspace');
    putJson(src, 'package.json', { devDependencies: { nx: '14.8.0' } });
    expect(detectNxWorkspace(src)).toMatchObject({ confidence: 0.5 });
    expect(detectNxWorkspace(src).reasons).toContain('Nx 14 is outside the supported 15–22');

    const empty = fixtureCopy('angular15-app');
    putJson(empty, 'nx.json', {});
    putJson(empty, 'package.json', { devDependencies: { nx: '17.0.6' } });
    expect(detectNxWorkspace(empty)).toMatchObject({ confidence: 0.3 });
    expect(detectNxWorkspace(empty).reasons).toContain('no project nx-polystack can migrate yet');
  });
});
