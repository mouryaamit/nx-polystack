import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { ANGULAR_SKIP } from '../../../src/generators/migrate/adapters/angular-cli';
import { FLUTTER_SKIP } from '../../../src/generators/migrate/adapters/flutter';
import { emptyReportData, recordCopy } from '../../../src/generators/migrate/adapters/types';
import {
  copyIntoTree,
  gitListedFiles,
  isPossibleSecret,
  shouldSkip,
} from '../../../src/generators/migrate/copy';

import { put, snapshot, tmpSource } from './helpers';

function git(dir: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
}

describe('migrate copy', () => {
  it('denies possible secrets at any depth, keeping example env files', () => {
    for (const p of [
      '.env',
      '.env.local',
      'config/.env.production',
      'android/app/upload.jks',
      'release.keystore',
      'android/key.properties',
      'certs/dev.p12',
      'certs/server.pem',
      'android/app/google-services.json',
      'ios/Runner/GoogleService-Info.plist',
      '.npmrc',
    ]) {
      expect([p, isPossibleSecret(p)]).toEqual([p, true]);
    }
    for (const p of [
      '.env.example',
      '.env.sample',
      'src/environments/environment.ts',
      'README.md',
    ]) {
      expect([p, isPossibleSecret(p)]).toEqual([p, false]);
    }
  });

  it('skips yarn caches, out-tsc, tmp, .svn, macOS Pods and Flutter ephemeral folders', () => {
    for (const p of ['.yarn/cache', 'out-tsc', 'tmp', '.svn', 'src/.svn']) {
      expect([p, shouldSkip(p, ANGULAR_SKIP)]).toEqual([p, true]);
    }
    for (const p of [
      'macos/Pods',
      'linux/flutter/ephemeral',
      'windows/flutter/ephemeral',
      'macos/Flutter/ephemeral',
      '.svn',
      '.yarn/cache',
    ]) {
      expect([p, shouldSkip(p, FLUTTER_SKIP)]).toEqual([p, true]);
    }
    expect(shouldSkip('src/tmp', ANGULAR_SKIP)).toBe(false);
    expect(shouldSkip('.yarn/releases', ANGULAR_SKIP)).toBe(false);
  });

  it('copies everything else, lists secrets apart from skipped paths', () => {
    const src = tmpSource();
    put(src, 'src/main.ts', 'x');
    put(src, '.env', 'TOKEN=1');
    put(src, '.env.example', 'TOKEN=');
    put(src, '.npmrc', '//registry/:_authToken=x');
    put(src, 'android/app/google-services.json', '{}');
    put(src, 'out-tsc/a.js', '');
    const r = copyIntoTree(createTreeWithEmptyWorkspace(), src, 'apps/a', ANGULAR_SKIP);
    expect(r.copied).toEqual(['.env.example', 'src/main.ts']);
    expect(r.secrets).toEqual(['.env', '.npmrc', 'android/app/google-services.json']);
    expect(r.skipped).toEqual(['out-tsc/']);
    expect(r.git).toBe(false);
  });

  it('keeps the file mode (an executable gradlew stays executable)', () => {
    const src = tmpSource();
    put(src, 'android/gradlew', '#!/bin/sh\n');
    fs.chmodSync(path.join(src, 'android/gradlew'), 0o755);
    put(src, 'README.md', '');
    fs.chmodSync(path.join(src, 'README.md'), 0o644);
    const tree = createTreeWithEmptyWorkspace();
    copyIntoTree(tree, src, 'apps/a', FLUTTER_SKIP);
    const modes = Object.fromEntries(
      tree
        .listChanges()
        .filter((c) => c.path.startsWith('apps/a/'))
        .map((c) => [c.path, c.options?.mode]),
    );
    expect(modes).toEqual({ 'apps/a/README.md': 0o644, 'apps/a/android/gradlew': 0o755 });
  });

  it('fails over --max-files', () => {
    const src = tmpSource();
    for (const f of ['a', 'b', 'c', 'd']) put(src, f, '');
    expect(() =>
      copyIntoTree(createTreeWithEmptyWorkspace(), src, 'apps/a', ANGULAR_SKIP, { maxFiles: 3 }),
    ).toThrow(
      'migrate: the source has more than 3 files to copy after the skip lists. Clean it up ' +
        '(build output, vendored dependencies, generated files) or raise --max-files.',
    );
    expect(() =>
      copyIntoTree(createTreeWithEmptyWorkspace(), src, 'apps/a', ANGULAR_SKIP, { maxFiles: 4 }),
    ).not.toThrow();
  });

  describe('outside a git work tree, honouring .gitignore files', () => {
    it('skips what the root and nested .gitignore files ignore', () => {
      const src = tmpSource();
      put(src, '.gitignore', '*.iml\n/build-cache/\nlocal.properties\n');
      put(src, 'lib/main.dart', 'void main() {}');
      put(src, 'app.iml', 'x');
      put(src, 'build-cache/a.txt', 'x');
      put(src, 'android/local.properties', 'sdk.dir=/Users/me/Android');
      put(
        src,
        'ios/.gitignore',
        'Flutter/Generated.xcconfig\nFlutter/flutter_export_environment.sh\n',
      );
      put(src, 'ios/Flutter/Generated.xcconfig', 'x');
      put(src, 'ios/Flutter/flutter_export_environment.sh', 'x');
      put(src, 'ios/Flutter/Debug.xcconfig', 'keep');
      const tree = createTreeWithEmptyWorkspace();
      const r = copyIntoTree(tree, src, 'apps/x', FLUTTER_SKIP);
      expect(r.git).toBe(false);
      expect(r.gitignore).toBe(true);
      expect(r.copied.sort()).toEqual(
        ['.gitignore', 'ios/.gitignore', 'ios/Flutter/Debug.xcconfig', 'lib/main.dart'].sort(),
      );
      expect(r.skipped).toEqual(
        expect.arrayContaining([
          'app.iml',
          'build-cache/',
          'android/local.properties',
          'ios/Flutter/Generated.xcconfig',
        ]),
      );
    });

    it('reports gitignore=false when there is no .gitignore', () => {
      const src = tmpSource();
      put(src, 'lib/main.dart', 'void main() {}');
      const r = copyIntoTree(createTreeWithEmptyWorkspace(), src, 'apps/x', FLUTTER_SKIP);
      expect(r.gitignore).toBe(false);
      expect(r.copied).toEqual(['lib/main.dart']);
    });
  });

  describe('in a git work tree', () => {
    let src: string;

    beforeEach(() => {
      src = tmpSource();
      git(src, 'init', '-q');
      put(src, '.gitignore', 'dist/\n*.log\nlocal/\n');
      put(src, 'src/main.ts', 'x');
      put(src, '.env.example', 'TOKEN=');
      put(src, 'dist/main.js', 'built');
      put(src, 'debug.log', 'log');
      put(src, 'local/notes.txt', 'mine');
      git(src, 'add', '.');
      git(src, 'commit', '-qm', 'init');
      put(src, 'src/new.ts', 'untracked');
      put(src, '.env', 'TOKEN=secret');
      put(src, 'node_modules/x/index.js', '');
      fs.rmSync(path.join(src, 'README.md'), { force: true });
    });

    it('lists tracked and untracked, not ignored, files', () => {
      expect(gitListedFiles(src)).toEqual([
        '.env',
        '.env.example',
        '.gitignore',
        'node_modules/x/index.js',
        'src/main.ts',
        'src/new.ts',
      ]);
      expect(gitListedFiles(tmpSource())).toBeUndefined();
    });

    it('copies only those files, still applying the skip and secret lists', () => {
      const before = snapshot(src);
      const r = copyIntoTree(createTreeWithEmptyWorkspace(), src, 'apps/a', ANGULAR_SKIP);
      expect(r.git).toBe(true);
      expect(r.copied).toEqual(['.env.example', '.gitignore', 'src/main.ts', 'src/new.ts']);
      expect(r.secrets).toEqual(['.env']);
      expect(r.skipped).toEqual(['node_modules/']);
      expect(snapshot(src)).toEqual(before);
    });

    it('lists files under a sub-folder relative to it', () => {
      put(src, 'projects/shop/src/app.ts', '');
      expect(gitListedFiles(path.join(src, 'projects/shop'))).toEqual(['src/app.ts']);
    });

    it('skips tracked files deleted from the work tree', () => {
      fs.rmSync(path.join(src, 'src/main.ts'));
      const r = copyIntoTree(createTreeWithEmptyWorkspace(), src, 'apps/a', ANGULAR_SKIP);
      expect(r.copied).not.toContain('src/main.ts');
    });
  });
});

describe('recordCopy', () => {
  it('adds to what earlier copies recorded', () => {
    const data = emptyReportData();
    const result = {
      copied: ['a.ts'],
      skipped: ['dist/'],
      secrets: ['.npmrc'],
      git: false,
      gitignore: true,
    };
    recordCopy(data, result, 'apps/one');
    recordCopy(data, { ...result, copied: ['b.ts', 'c.ts'], gitignore: false }, 'libs/two');
    expect(data.copied).toBe(3);
    expect(data.skipped).toEqual(['apps/one/dist/', 'libs/two/dist/']);
    expect(data.secrets).toEqual(['apps/one/.npmrc', 'libs/two/.npmrc']);
    expect(data.gitignoreUsed).toBe(true);
    expect(data.notes.filter((n) => n.startsWith('`.npmrc` was not copied'))).toHaveLength(1);
  });
});

describe('copyIntoTree from a folder inside the repo (no git)', () => {
  it('applies the .gitignore files of the folders above it', () => {
    const repo = tmpSource();
    put(repo, '.gitignore', 'generated/\n*.log\n');
    put(repo, 'apps/.gitignore', 'local.json\n');
    put(repo, 'apps/web/src/main.ts', 'x');
    put(repo, 'apps/web/generated/a.ts', 'x');
    put(repo, 'apps/web/debug.log', 'x');
    put(repo, 'apps/web/local.json', '{}');
    const tree = createTreeWithEmptyWorkspace();
    const result = copyIntoTree(
      tree,
      path.join(repo, 'apps', 'web'),
      'apps/web',
      { anyDepth: [], topLevel: [] },
      { ignoreFrom: repo },
    );
    expect(result.copied).toEqual(['src/main.ts']);
    expect(result.gitignore).toBe(true);
  });
});
