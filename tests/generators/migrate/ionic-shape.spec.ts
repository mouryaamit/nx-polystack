import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { applyIonicShape, nativeImports } from '../../../src/generators/migrate/ionic/shape';

function app(tree: Tree, root: string, project: Record<string, unknown>): void {
  tree.write(`${root}/project.json`, JSON.stringify(project));
}

const angularProject = (name: string, outputPath: string) => ({
  name,
  tags: ['scope:app', 'type:app', 'platform:web'],
  targets: {
    build: {
      executor: '@angular-devkit/build-angular:browser',
      options: { outputPath, assets: ['apps/a/src/assets'] },
      configurations: { production: {}, development: {} },
    },
    release: {
      executor: '@mouryaamit/nx-polystack:build',
      options: { type: 'angular', outputPath },
      configurations: { dev: {}, prod: {} },
    },
    cap: { executor: '@nxext/capacitor:cap', options: { cmd: 'sync' } },
  },
});

describe('applyIonicShape', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write('package.json', JSON.stringify({ name: 'ws', scripts: {} }));
  });

  it('reshapes a standalone app whose output was www', () => {
    app(tree, 'apps/a', angularProject('a', 'apps/a/www'));
    tree.write('apps/a/capacitor.config.ts', `export default { appId: 'x', webDir: 'www' };\n`);
    tree.write('apps/a/android/app/build.gradle', '');
    const { report, installApp } = applyIonicShape(tree, {
      name: 'a',
      appRoot: 'apps/a',
      sourcePkg: {
        dependencies: {
          '@ionic/angular': '^7.0.0',
          '@capacitor/core': '5.7.0',
          'cordova-plugin-device': '2.1.0',
        },
        devDependencies: { '@capacitor/cli': '5.7.0' },
      },
      alsoAtRoot: new Set(),
      releaseConfigurations: ['dev', 'prod'],
    });

    const pj = readJson(tree, 'apps/a/project.json');
    expect(pj.targets.build.options.outputPath).toBe('dist/apps/a');
    expect(pj.targets.release.options).toEqual({ type: 'ionic', outputPath: 'dist/apps/a' });
    expect(pj.targets['cap-sync']).toEqual({
      executor: '@mouryaamit/nx-polystack:capacitor',
      options: { command: 'sync' },
    });
    expect(pj.targets['cap-open'].options.command).toBe('open');
    expect(pj.targets['cap-add'].options.command).toBe('add');
    expect(pj.targets.cap).toBeUndefined();
    expect(pj.targets.build.options.assets).toContainEqual({
      glob: '**/*.svg',
      input: 'node_modules/ionicons/dist/ionicons/svg',
      output: './svg',
    });
    expect(pj.tags).toEqual(['scope:app', 'type:app', 'platform:mobile']);

    expect(tree.read('apps/a/capacitor.config.ts', 'utf8')).toContain(
      "webDir: '../../dist/apps/a'",
    );
    expect(readJson(tree, 'apps/a/package.json')).toEqual({
      name: 'a-native',
      private: true,
      dependencies: { '@capacitor/core': '5.7.0', 'cordova-plugin-device': '2.1.0' },
      devDependencies: { '@capacitor/cli': '5.7.0' },
    });

    const scripts = readJson(tree, 'package.json').scripts;
    expect(scripts['build:a:prod:android']).toBe(
      'nx run a:release:prod && nx run a:cap-sync --platform=android',
    );
    expect(scripts['build:a:dev:ios']).toBe(
      'nx run a:release:dev && nx run a:cap-sync --platform=ios',
    );
    expect(scripts['open:a:android']).toBe('nx run a:cap-open --platform=android');

    expect(report).toEqual({
      project: 'a',
      packagePath: 'apps/a/package.json',
      ionic: '^7.0.0',
      workspaceCapacitor: 5,
      capacitor: '5.7.0',
      nativePackages: ['@capacitor/cli', '@capacitor/core', 'cordova-plugin-device'],
      alsoAtRoot: [],
      otherApps: [],
      webDir: { file: 'capacitor.config.ts', from: 'www', to: '../../dist/apps/a' },
      platforms: ['android'],
      cordovaPlugins: ['cordova-plugin-device'],
      droppedTargets: ['cap (@nxext/capacitor:cap)'],
      outputPathMoved: 'apps/a/www',
    });
    expect(typeof installApp).toBe('function');
  });

  it('keeps an app package.json, a dist output and an existing ionicons asset', () => {
    const project = angularProject('field', 'dist/apps/field');
    (project.targets.build.options.assets as unknown[]).push({
      glob: '**/*.svg',
      input: 'node_modules/ionicons/dist/ionicons/svg',
      output: './svg',
    });
    app(tree, 'apps/field', project);
    tree.write(
      'apps/field/package.json',
      JSON.stringify({ name: 'field', dependencies: { '@capacitor/core': '5.6.0' } }),
    );
    tree.write(
      'apps/field/capacitor.config.ts',
      `export default { webDir: '../../dist/apps/field' };\n`,
    );
    const { report } = applyIonicShape(tree, {
      name: 'field',
      appRoot: 'apps/field',
      sourcePkg: { dependencies: { '@capacitor/core': '5.7.0', '@capacitor/camera': '5.0.0' } },
      alsoAtRoot: new Set(['@capacitor/core']),
      releaseConfigurations: ['prod'],
    });
    const pj = readJson(tree, 'apps/field/project.json');
    expect(pj.targets.build.options.outputPath).toBe('dist/apps/field');
    expect(
      pj.targets.build.options.assets.filter((a: { input?: string }) =>
        String(a.input ?? '').includes('ionicons'),
      ),
    ).toHaveLength(1);
    expect(readJson(tree, 'apps/field/package.json').dependencies).toEqual({
      '@capacitor/core': '5.6.0',
      '@capacitor/camera': '5.0.0',
    });
    expect(report.alsoAtRoot).toEqual(['@capacitor/core']);
    expect(report.outputPathMoved).toBeUndefined();
    expect(report.platforms).toEqual([]);
  });

  it('passes webDir to the cap targets when the output is not dist/apps/<name>', () => {
    app(tree, 'apps/field', angularProject('acme-field', 'dist/apps/field'));
    tree.write('apps/field/capacitor.config.json', JSON.stringify({ webDir: 'www' }));
    applyIonicShape(tree, {
      name: 'acme-field',
      appRoot: 'apps/field',
      sourcePkg: {},
      alsoAtRoot: new Set(),
      releaseConfigurations: [],
    });
    const pj = readJson(tree, 'apps/field/project.json');
    expect(pj.targets['cap-sync'].options).toEqual({ command: 'sync', webDir: 'dist/apps/field' });
    expect(readJson(tree, 'apps/field/capacitor.config.json').webDir).toBe('../../dist/apps/field');
    expect(tree.exists('apps/field/package.json')).toBe(false);
  });

  it('leaves a source release target alone and adds ionicons only for Ionic apps', () => {
    const project = angularProject('a', 'dist/apps/a');
    (project.targets as Record<string, unknown>).release = {
      executor: 'nx:run-commands',
      options: { command: 'nx release', outputPath: 'apps/a/out' },
    };
    app(tree, 'apps/a', project);
    applyIonicShape(tree, {
      name: 'a',
      appRoot: 'apps/a',
      sourcePkg: { dependencies: { '@capacitor/core': '5.7.0' } },
      alsoAtRoot: new Set(),
      releaseConfigurations: [],
    });
    const pj = readJson(tree, 'apps/a/project.json');
    expect(pj.targets.release).toEqual({
      executor: 'nx:run-commands',
      options: { command: 'nx release', outputPath: 'apps/a/out' },
    });
    expect(JSON.stringify(pj.targets.build.options.assets)).not.toContain('ionicons');
  });

  it('moves an object outputPath and configuration overrides inside the app folder', () => {
    const project = angularProject('a', 'dist/apps/a');
    const build = project.targets.build as {
      options: Record<string, unknown>;
      configurations: Record<string, Record<string, unknown>>;
    };
    build.options.outputPath = { base: 'apps/a/www' };
    build.configurations.production = { outputPath: 'apps/a/www-prod' };
    (project.targets.release.options as Record<string, unknown>).outputPath = {
      base: 'apps/a/www',
    };
    app(tree, 'apps/a', project);
    const { report } = applyIonicShape(tree, {
      name: 'a',
      appRoot: 'apps/a',
      sourcePkg: {},
      alsoAtRoot: new Set(),
      releaseConfigurations: [],
    });
    const pj = readJson(tree, 'apps/a/project.json');
    expect(pj.targets.build.options.outputPath).toEqual({ base: 'dist/apps/a' });
    expect(pj.targets.build.configurations.production.outputPath).toBe('dist/apps/a');
    expect(pj.targets.release.options.outputPath).toEqual({ base: 'dist/apps/a' });
    expect(pj.targets['cap-sync'].options).toEqual({ command: 'sync' });
    expect(report.outputPathMoved).toBe('apps/a/www');
  });

  it('gives this app only the packages forThisApp picks, optional ones included', () => {
    app(tree, 'apps/a', angularProject('a', 'dist/apps/a'));
    const { report } = applyIonicShape(tree, {
      name: 'a',
      appRoot: 'apps/a',
      sourcePkg: {
        dependencies: { '@capacitor/core': '5.7.0', '@capacitor/camera': '5.0.0' },
        optionalDependencies: { 'cordova-plugin-file': '8.0.0' },
      },
      forThisApp: (n) => n !== '@capacitor/camera',
      alsoAtRoot: new Set(),
      releaseConfigurations: [],
    });
    expect(readJson(tree, 'apps/a/package.json')).toEqual({
      name: 'a-native',
      private: true,
      dependencies: { '@capacitor/core': '5.7.0' },
      optionalDependencies: { 'cordova-plugin-file': '8.0.0' },
    });
    expect(report.otherApps).toEqual(['@capacitor/camera']);
  });

  it('collects the native packages the code imports', () => {
    tree.write('apps/a/src/main.ts', "import { Camera } from '@capacitor/camera';\n");
    tree.write('apps/a/src/x.ts', "import '@awesome-cordova-plugins/core/ngx'; import 'rxjs';\n");
    tree.write('apps/a/android/x.js', "require('@capacitor/ios');\n");
    expect([...nativeImports(tree, 'apps/a')].sort()).toEqual([
      '@awesome-cordova-plugins/core',
      '@capacitor/camera',
    ]);
  });

  it("adds @ionic/angular's Angular peers when they are missing", () => {
    tree.write(
      'package.json',
      JSON.stringify({ name: 'ws', scripts: {}, dependencies: { '@angular/core': '~15.2.0' } }),
    );
    app(tree, 'apps/a', angularProject('a', 'dist/apps/a'));
    const { rootPackagesAdded } = applyIonicShape(tree, {
      name: 'a',
      appRoot: 'apps/a',
      sourcePkg: { dependencies: { '@ionic/angular': '^7.8.0' } },
      alsoAtRoot: new Set(),
      releaseConfigurations: [],
    });
    expect(readJson(tree, 'package.json').dependencies['@angular/forms']).toBe('~15.2.0');
    expect(rootPackagesAdded).toEqual(['@angular/forms', '@angular/router']);

    // Never without Ionic, never replacing a declared version.
    const plain = createTreeWithEmptyWorkspace();
    plain.write(
      'package.json',
      JSON.stringify({
        dependencies: {
          '@angular/core': '~15.2.0',
          '@angular/forms': '15.1.0',
          '@angular/router': '15.1.0',
        },
      }),
    );
    app(plain, 'apps/a', angularProject('a', 'dist/apps/a'));
    expect(
      applyIonicShape(plain, {
        name: 'a',
        appRoot: 'apps/a',
        sourcePkg: { dependencies: { '@ionic/angular': '^7.8.0' } },
        alsoAtRoot: new Set(),
        releaseConfigurations: [],
      }).rootPackagesAdded,
    ).toEqual([]);
    expect(readJson(plain, 'package.json').dependencies['@angular/forms']).toBe('15.1.0');
  });
});
