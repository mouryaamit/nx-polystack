import * as fs from 'fs';
import * as path from 'path';

import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { buildProjectJson } from '../../../src/generators/app/generator';
import {
  FLUTTER_SKIP,
  outsidePathDependencies,
} from '../../../src/generators/migrate/adapters/flutter';
import { shouldSkip } from '../../../src/generators/migrate/copy';
import migrateGenerator from '../../../src/generators/migrate/generator';
import { LLM_END, LLM_START } from '../../../src/lib/utils/llm-block';

import { FIXTURES, fixtureCopy, put, snapshot } from './helpers';

const FIXTURE = path.join(FIXTURES, 'flutter-app');

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write('package.json', JSON.stringify({ scripts: {}, devDependencies: { nx: '~17.0.6' } }));
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  return tree;
}

describe('migrate generator: standalone Flutter app', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = workspace();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('skip rules cover build output, tool caches and native dependency folders', () => {
    for (const p of [
      'build',
      '.dart_tool',
      'packages/x/.dart_tool',
      '.git',
      '.idea',
      '.packages',
      '.flutter-plugins',
      '.flutter-plugins-dependencies',
      'ios/Pods',
      'ios/.symlinks',
      'android/.gradle',
    ]) {
      expect([p, shouldSkip(p, FLUTTER_SKIP)]).toEqual([p, true]);
    }
    for (const p of ['pubspec.lock', 'lib/build', 'lib/main.dart', 'android/app', 'ios/Runner']) {
      expect([p, shouldSkip(p, FLUTTER_SKIP)]).toEqual([p, false]);
    }
  });

  it('defaults the name to the pubspec name, kebab-cased', async () => {
    await migrateGenerator(tree, { source: FIXTURE });
    expect(readJson(tree, 'apps/field-notes/project.json').name).toBe('field-notes');
  });

  describe('the migrated app', () => {
    beforeEach(async () => {
      await migrateGenerator(tree, { source: FIXTURE, name: 'notes' });
    });

    it('copies the app, skipping build/ and .dart_tool/', () => {
      for (const f of [
        'pubspec.yaml',
        'lib/main.dart',
        'test/widget_test.dart',
        'analysis_options.yaml',
        'android/app/build.gradle',
        'ios/Runner/Info.plist',
        'README.md',
      ]) {
        expect([f, tree.exists(`apps/notes/${f}`)]).toEqual([f, true]);
      }
      expect(tree.exists('apps/notes/build')).toBe(false);
      expect(tree.exists('apps/notes/.dart_tool')).toBe(false);
    });

    it('writes the pstack app --type=flutter project.json, without the FlutterFlow export target', () => {
      const pj = readJson(tree, 'apps/notes/project.json');
      expect(pj).toEqual(buildProjectJson('notes', { exportTarget: false, port: 4200 }));
      expect(pj.targets.serve.options.port).toBe(4200);
      expect(pj.tags).toEqual(['scope:app', 'type:app', 'platform:flutter']);
      expect(Object.keys(pj.targets)).toEqual([
        'serve',
        'build-web',
        'build-android',
        'build-ios',
        'clean',
      ]);
    });

    it('keeps the existing env file and creates the missing ones empty', () => {
      expect(readJson(tree, 'apps/notes/env/dev.json')).toEqual({
        FLUTTER_ENV: 'dev',
        API_BASE_URL: 'https://dev.internal.test',
      });
      expect(tree.read('apps/notes/env/uat.json', 'utf8')).toBe('{}\n');
      expect(tree.read('apps/notes/env/prod.json', 'utf8')).toBe('{}\n');
    });

    it('adds the pstack app --type=flutter npm scripts', () => {
      const scripts = readJson(tree, 'package.json').scripts;
      expect(scripts['serve:notes']).toBe('nx serve notes');
      expect(scripts['build:notes:prod:web']).toBe('nx run notes:build-web:prod');
      expect(scripts['build:notes:dev:apk']).toBe('nx run notes:build-android:dev');
      expect(scripts['build:notes:uat:ios']).toBe('nx run notes:build-ios:uat');
      expect(scripts['export:notes']).toBeUndefined();
      expect(scripts['clean:notes']).toBe('nx run notes:clean');
      expect(Object.keys(scripts)).toHaveLength(11);
    });

    it('adds no npm dependencies', () => {
      expect(readJson(tree, 'package.json').dependencies).toBeUndefined();
    });

    it('writes the report', () => {
      const report = tree.read('docs/migrations/notes.md', 'utf8') ?? '';
      expect(report).toContain('- Adapter: `flutter` (standalone Flutter app)');
      expect(report).toContain('- Files copied: 8');
      expect(report).toContain('- Paths skipped: 2');
      expect(report).toContain('- `.dart_tool/`\n- `build/`');
      expect(report).toContain(
        'pubspec.yaml dependencies: `shared_models` has `path: ../shared_models`, outside the source repo.',
      );
      expect(report).toContain(
        'Created empty `apps/notes/env/uat.json`, `apps/notes/env/prod.json`',
      );
      expect(report).toContain(
        '- [ ] Fill `apps/notes/env/<env>.json` (dev, uat, prod); they are passed to Flutter with `--dart-define-from-file`',
      );
      expect(report).toContain('- [ ] `cd apps/notes && flutter pub get`');
      expect(report).toContain('- [ ] `npx nx run notes:build-web:dev`');
      expect(report).not.toContain('## Dependencies');
      expect(report).not.toContain('## TypeScript path aliases');
    });
  });

  it('writes {} env files when the source has none, and never touches existing ones', async () => {
    const src = fixtureCopy('flutter-app');
    fs.rmSync(path.join(src, 'env'), { recursive: true });
    await migrateGenerator(tree, { source: src, name: 'notes' });
    for (const env of ['dev', 'uat', 'prod']) {
      expect(tree.read(`apps/notes/env/${env}.json`, 'utf8')).toBe('{}\n');
    }
  });

  it('notes product flavors and extra entrypoints that the build targets do not pass', async () => {
    const src = fixtureCopy('flutter-app');
    fs.rmSync(path.join(src, 'android/app/build.gradle'));
    put(
      src,
      'android/app/build.gradle.kts',
      'android {\n  flavorDimensions += "env"\n  productFlavors {\n    create("staging") {}\n  }\n}\n',
    );
    put(src, 'lib/main_staging.dart', 'void main() {}\n');
    put(src, 'lib/main_prod.dart', 'void main() {}\n');
    await migrateGenerator(tree, { source: src, name: 'notes' });
    const report = tree.read('docs/migrations/notes.md', 'utf8') ?? '';
    expect(report).toContain(
      '`android/app/build.gradle.kts` defines product flavors. The build-* targets do not pass `--flavor`',
    );
    expect(report).toContain(
      'Extra entrypoints `lib/main_prod.dart`, `lib/main_staging.dart`: the build-* targets build `lib/main.dart` and do not pass `-t`',
    );
  });

  it('lists only path dependencies outside the source', () => {
    expect(
      outsidePathDependencies('/repo/app', {
        flutterSdk: true,
        pathDependencies: [
          { section: 'dependencies', name: 'inside', path: 'packages/inside' },
          { section: 'dependencies', name: 'outside', path: '../outside' },
          { section: 'dev_dependencies', name: 'abs', path: '/opt/pkgs/abs' },
        ],
      }).map((d) => d.name),
    ).toEqual(['outside', 'abs']);
  });

  it('skips Pods, symlinks and Gradle caches, and never modifies the source', async () => {
    const src = fixtureCopy('flutter-app');
    put(src, 'ios/Pods/Manifest.lock', 'x');
    put(src, 'android/.gradle/cache', 'x');
    put(src, '.flutter-plugins-dependencies', '{}');
    put(src, 'pubspec.lock', 'packages: {}\n');
    const before = snapshot(src);
    await migrateGenerator(tree, { source: src, name: 'notes' });
    expect(snapshot(src)).toEqual(before);
    expect(tree.exists('apps/notes/ios/Pods')).toBe(false);
    expect(tree.exists('apps/notes/android/.gradle')).toBe(false);
    expect(tree.exists('apps/notes/.flutter-plugins-dependencies')).toBe(false);
    expect(tree.exists('apps/notes/pubspec.lock')).toBe(true);
  });

  it('refreshes the llm block with the Flutter app', async () => {
    tree.write('AGENTS.md', `# AGENTS.md\n\n${LLM_START}\nold\n${LLM_END}\n`);
    await migrateGenerator(tree, { source: FIXTURE, name: 'notes' });
    const md = tree.read('AGENTS.md', 'utf8') ?? '';
    expect(md).toContain('| `notes` | flutter | `apps/notes` |');
  });
});

describe('--min-confidence', () => {
  it('migrates a 0.60 match at 0.6 and says so in the report', async () => {
    const tree = workspace();
    const src = fixtureCopy('flutter-app');
    fs.rmSync(path.join(src, 'lib/main.dart'));
    await expect(migrateGenerator(tree, { source: src, name: 'notes' })).rejects.toThrow(
      '--min-confidence=0.6',
    );
    await migrateGenerator(tree, { source: src, name: 'notes', minConfidence: 0.6 });
    expect(tree.read('docs/migrations/notes.md', 'utf-8')).toContain(
      '- Confidence: 0.60 (accepted with --min-confidence=0.6)',
    );
  });

  it('does not mention the threshold when the default would have accepted the match', async () => {
    const tree = workspace();
    await migrateGenerator(tree, {
      source: fixtureCopy('flutter-app'),
      name: 'notes',
      minConfidence: 0.6,
    });
    expect(tree.read('docs/migrations/notes.md', 'utf-8')).toContain('- Confidence: 1.00\n');
  });

  it('checks the value before --detect', async () => {
    await expect(
      migrateGenerator(workspace(), {
        source: fixtureCopy('flutter-app'),
        detect: true,
        minConfidence: 7,
      }),
    ).rejects.toThrow('from 0.50 to 1.00 (got 7)');
  });

  it('is refused with --adapter, --rollback and out of range', async () => {
    const tree = workspace();
    const src = fixtureCopy('flutter-app');
    await expect(
      migrateGenerator(tree, { source: src, adapter: 'flutter', minConfidence: 0.6 }),
    ).rejects.toThrow('--adapter skips detection, so --min-confidence has no effect');
    await expect(migrateGenerator(tree, { rollback: 'x', minConfidence: 0.6 })).rejects.toThrow(
      '--rollback takes only --force',
    );
    await expect(migrateGenerator(tree, { source: src, minConfidence: 0.2 })).rejects.toThrow(
      'from 0.50 to 1.00 (got 0.2)',
    );
  });
});
