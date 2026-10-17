import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { detectAll } from '../../../src/generators/migrate/adapters';
import migrateGenerator from '../../../src/generators/migrate/generator';

import { fixtureCopy, put, putJson, readJsonFile, snapshot } from './helpers';

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({
      name: '@acme/workspace',
      scripts: {},
      devDependencies: { nx: '~17.0.6', '@nx/eslint': '~17.0.6' },
    }),
  );
  tree.write(
    'tsconfig.base.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {} } }),
  );
  return tree;
}

describe('migrate generator: standalone Ionic app', () => {
  it('is picked by detection', () => {
    expect(detectAll(fixtureCopy('ionic7-app'))[0].adapter.id).toBe('ionic');
  });

  it('migrates into the polystack Ionic shape', async () => {
    const src = fixtureCopy('ionic7-app');
    const before = snapshot(src);
    const tree = workspace();
    const task = await migrateGenerator(tree, { source: src });

    expect(snapshot(src)).toEqual(before);
    expect(typeof task).toBe('function');
    // Copied, without native build output or www
    expect(tree.exists('apps/field-notes/android/app/src/main/AndroidManifest.xml')).toBe(true);
    expect(tree.exists('apps/field-notes/ios/App/Podfile')).toBe(true);
    expect(tree.exists('apps/field-notes/android/app/build/outputs/app.apk')).toBe(false);
    expect(tree.exists('apps/field-notes/android/.gradle/cache.bin')).toBe(false);
    expect(tree.exists('apps/field-notes/android/local.properties')).toBe(false);
    expect(tree.exists('apps/field-notes/ios/App/Pods/Target/lib.a')).toBe(false);
    expect(tree.exists('apps/field-notes/www/index.html')).toBe(false);

    const pj = readJson(tree, 'apps/field-notes/project.json');
    expect(pj.targets.build.options.outputPath).toBe('dist/apps/field-notes');
    expect(pj.targets.release.options.type).toBe('ionic');
    expect(pj.targets['cap-sync'].options).toEqual({ command: 'sync' });
    expect(pj.tags).toContain('platform:mobile');
    expect(pj.tags).not.toContain('platform:web');
    expect(
      pj.targets.build.options.assets.filter((a: { input?: string }) =>
        String(a.input ?? '').includes('ionicons'),
      ),
    ).toHaveLength(1);

    expect(tree.read('apps/field-notes/capacitor.config.ts', 'utf8')).toContain(
      "webDir: '../../dist/apps/field-notes'",
    );
    const appPkg = readJson(tree, 'apps/field-notes/package.json');
    expect(appPkg.dependencies['@capacitor/core']).toBe('5.7.0');
    expect(appPkg.dependencies['cordova-plugin-device']).toBe('2.1.0');
    expect(appPkg.devDependencies['@capacitor/cli']).toBe('5.7.0');

    const root = readJson(tree, 'package.json');
    expect(root.dependencies['@ionic/angular']).toBe('^7.8.0');
    expect(root.dependencies['ionicons']).toBe('^7.0.0');
    expect(root.dependencies['@capacitor/core']).toBeUndefined();
    expect(root.devDependencies['@capacitor/cli']).toBeUndefined();
    expect(root.scripts['build:field-notes:prod:android']).toBe(
      'nx run field-notes:release:prod && nx run field-notes:cap-sync --platform=android',
    );
    expect(root.scripts['open:field-notes:ios']).toBe('nx run field-notes:cap-open --platform=ios');

    const report = tree.read('docs/migrations/field-notes.md', 'utf8')!;
    expect(report).toContain('- Adapter: `ionic` (standalone Ionic or Capacitor Angular app)');
    expect(report).toContain('## Ionic');
    expect(report).toContain(
      '- `webDir` in `capacitor.config.ts`: `www` → `../../dist/apps/field-notes`',
    );
    expect(report).toContain('- Native platforms copied: android, ios');
    expect(report).toContain('`cordova-plugin-device`');
    expect(report).toContain('`npx nx run field-notes:cap-sync --platform=android`');
  });

  it('ignores an e2e-only project (app + app-e2e, as older Ionic templates have)', async () => {
    const src = fixtureCopy('ionic7-app');
    const ws = readJsonFile<{ projects: Record<string, unknown> }>(src, 'angular.json');
    ws.projects['app-e2e'] = {
      projectType: 'application',
      root: 'e2e',
      architect: { e2e: { builder: '@angular-devkit/build-angular:protractor' } },
    };
    putJson(src, 'angular.json', ws);
    put(src, 'e2e/protractor.conf.js', 'exports.config = {};\n');
    const rows = detectAll(src);
    expect(rows[0].adapter.id).toBe('ionic');
    expect(rows.find((r) => r.adapter.id === 'angular-workspace')?.confidence).toBe(0);

    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(tree.exists('apps/field-notes/project.json')).toBe(true);
    expect(tree.exists('apps/field-notes/e2e/protractor.conf.js')).toBe(false);
    expect(tree.read('docs/migrations/field-notes.md', 'utf8')).toContain(
      '`app-e2e` (`e2e`) not migrated (e2e projects are not supported yet).',
    );
  });

  it('converts an Ionic app on the Angular 17+ application builder', async () => {
    const src = fixtureCopy('ionic7-app');
    const ws = readJsonFile<{
      projects: Record<string, { architect: Record<string, Record<string, unknown>> }>;
    }>(src, 'angular.json');
    const build = ws.projects['app'].architect['build'];
    const { main, outputPath, ...options } = build['options'] as Record<string, unknown>;
    ws.projects['app'].architect['build'] = {
      ...build,
      builder: '@angular-devkit/build-angular:application',
      options: { ...options, browser: main, outputPath: { base: outputPath, browser: '' } },
    };
    putJson(src, 'angular.json', ws);
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    const pj = readJson(tree, 'apps/field-notes/project.json');
    expect(pj.targets.build.executor).toBe('@angular-devkit/build-angular:browser');
    expect(pj.targets.build.options).toMatchObject({
      main: 'apps/field-notes/src/main.ts',
      outputPath: 'dist/apps/field-notes',
    });
    expect(pj.targets.release.options.type).toBe('ionic');
    expect(tree.read('apps/field-notes/capacitor.config.ts', 'utf8')).toContain(
      "webDir: '../../dist/apps/field-notes'",
    );
  });
});
