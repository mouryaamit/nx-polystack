import { readJson, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import addLibBuildDependencies from '../../src/migrations/add-lib-build-dependencies/add-lib-build-dependencies';

function tree(devDeps: Record<string, string>) {
  const t = createTreeWithEmptyWorkspace();
  updateJson(t, 'package.json', (j) => ({
    ...j,
    dependencies: { '@angular/core': '~15.2.10' },
    devDependencies: devDeps,
  }));
  return t;
}

function project(t: ReturnType<typeof tree>, root: string, executor: string) {
  t.write(
    `${root}/project.json`,
    JSON.stringify({ name: root.split('/').pop(), targets: { build: { executor } } }),
  );
}

describe('add-lib-build-dependencies migration', () => {
  it('adds the PostCSS packages and ng-packagr when a lib uses ng-packagr-lite', async () => {
    const t = tree({ nx: '17.0.6' });
    project(t, 'libs/shared/widgets', '@nx/angular:ng-packagr-lite');
    const cb = await addLibBuildDependencies(t);
    expect(readJson(t, 'package.json').devDependencies).toMatchObject({
      'ng-packagr': '^15.0.0',
      postcss: '^8.4.5',
      'postcss-preset-env': '~7.5.0',
      'postcss-url': '~10.1.3',
      autoprefixer: '^10.4.0',
    });
    expect(typeof cb).toBe('function');
  });

  it('also detects @nx/angular:package and keeps existing versions', async () => {
    const t = tree({ nx: '17.0.6', 'ng-packagr': '15.2.2', postcss: '8.4.31' });
    project(t, 'libs/shared/ui', '@nx/angular:package');
    await addLibBuildDependencies(t);
    const dev = readJson(t, 'package.json').devDependencies;
    expect(dev['ng-packagr']).toBe('15.2.2');
    expect(dev.postcss).toBe('8.4.31');
    expect(dev['postcss-preset-env']).toBe('~7.5.0');
  });

  it('does nothing when no project uses a package executor', async () => {
    const t = tree({ nx: '17.0.6' });
    project(t, 'libs/shared/util', '@nx/eslint:lint');
    project(t, 'apps/web', '@angular-devkit/build-angular:browser');
    expect(await addLibBuildDependencies(t)).toBeUndefined();
    expect(readJson(t, 'package.json').devDependencies['postcss-preset-env']).toBeUndefined();
  });
});
