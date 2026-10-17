import * as path from 'path';

import { Tree } from '@nx/devkit';

import { generateFlutterEnvFiles } from '../../../lib/utils/env-files';
import { addNpmScripts } from '../../../lib/utils/npm-scripts';
import { nextFreePort, usedServePorts } from '../../../lib/utils/serve-port';
import { buildNpmScripts, buildProjectJson } from '../../app/generator';
import { copyIntoTree, SkipRules } from '../copy';
import { readSourceText, sourceExists } from '../source';

import {
  Detection,
  emptyReportData,
  MigrationAdapter,
  recordCopy,
  MigrationContext,
  MigrationReportData,
} from './types';

export interface PathDependency {
  /** pubspec section: dependencies, dev_dependencies or dependency_overrides. */
  section: string;
  name: string;
  path: string;
}

export interface PubspecInfo {
  name?: string;
  /** `flutter: sdk: flutter` under dependencies. */
  flutterSdk: boolean;
  pathDependencies: PathDependency[];
}

const DEP_SECTIONS = new Set(['dependencies', 'dev_dependencies', 'dependency_overrides']);

function unquote(v: string): string {
  const t = v.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/**
 * The few pubspec.yaml facts :migrate needs, read line by line (block-style YAML, as
 * `flutter create` writes it). Not a general YAML parser.
 */
export function readPubspec(text: string): PubspecInfo {
  const info: PubspecInfo = { flutterSdk: false, pathDependencies: [] };
  let section: string | undefined;
  let pkg: string | undefined;
  let pkgIndent = -1;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const m = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = unquote(m[1]);
    const value = m[2];

    if (indent === 0) {
      section = key;
      pkg = undefined;
      if (key === 'name' && value) info.name = unquote(value);
      continue;
    }
    if (!section || !DEP_SECTIONS.has(section)) continue;

    if (pkg === undefined || indent <= pkgIndent) {
      pkg = key;
      pkgIndent = indent;
      continue;
    }
    if (
      key === 'sdk' &&
      pkg === 'flutter' &&
      unquote(value) === 'flutter' &&
      section === 'dependencies'
    ) {
      info.flutterSdk = true;
    }
    if (key === 'path' && value) {
      info.pathDependencies.push({ section, name: pkg, path: unquote(value) });
    }
  }
  return info;
}

export function readSourcePubspec(sourceDir: string): PubspecInfo | undefined {
  const text = readSourceText(sourceDir, 'pubspec.yaml');
  return text === undefined ? undefined : readPubspec(text);
}

export function detectFlutter(sourceDir: string): Detection {
  if (sourceExists(sourceDir, 'nx.json')) {
    return { confidence: 0, reasons: ['nx.json: an Nx workspace, not a standalone Flutter app'] };
  }
  const pubspec = readSourcePubspec(sourceDir);
  if (!pubspec) return { confidence: 0, reasons: ['no pubspec.yaml'] };
  if (!pubspec.flutterSdk) {
    return {
      confidence: 0,
      reasons: ['pubspec.yaml has no flutter SDK dependency (a Dart package, not a Flutter app)'],
    };
  }
  let confidence = 0.6;
  const reasons = ['pubspec.yaml depends on the Flutter SDK'];
  if (sourceExists(sourceDir, 'lib/main.dart')) {
    confidence += 0.4;
    reasons.push('lib/main.dart present');
  } else {
    reasons.push('lib/main.dart missing');
  }
  return { confidence: Math.round(confidence * 100) / 100, reasons };
}

export const flutterAdapter: MigrationAdapter = {
  id: 'flutter',
  label: 'standalone Flutter app',
  detect: detectFlutter,
  defaultName(sourceDir: string): string | undefined {
    return readSourcePubspec(sourceDir)?.name;
  },
  migrate: migrateFlutter,
};

/** Not copied: build output, tool caches, generated plugin lists, CocoaPods and Gradle state. */
export const FLUTTER_SKIP: SkipRules = {
  anyDepth: ['.git', '.dart_tool'],
  topLevel: ['build', '.idea', '.packages', 'nx.json'],
  topLevelPatterns: [/^\.flutter-plugins/],
  paths: [
    'ios/Pods',
    'ios/.symlinks',
    'ios/build',
    'macos/Pods',
    'android/.gradle',
    'android/build',
    'android/app/build',
  ],
  // linux/flutter/ephemeral, windows/flutter/ephemeral, macos/Flutter/ephemeral, …
  pathPatterns: [/(^|\/)flutter\/ephemeral$/i],
};

/** Path dependencies that resolve outside the source repo (they break after the move). */
export function outsidePathDependencies(sourceDir: string, pubspec: PubspecInfo): PathDependency[] {
  const root = path.resolve(sourceDir);
  return pubspec.pathDependencies.filter((d) => {
    const target = path.resolve(root, d.path);
    return target !== root && !target.startsWith(root + path.sep);
  });
}

function migrateFlutter(tree: Tree, ctx: MigrationContext): MigrationReportData {
  const { sourceDir, name, projectRoot } = ctx;
  const data = emptyReportData();
  data.npmProject = false;

  const copy = copyIntoTree(tree, sourceDir, projectRoot, FLUTTER_SKIP, {
    maxFiles: ctx.maxFiles,
  });
  recordCopy(data, copy, '');

  tree.write(
    `${projectRoot}/project.json`,
    JSON.stringify(
      buildProjectJson(name, {
        exportTarget: false,
        root: projectRoot,
        port: nextFreePort(usedServePorts(tree).map((u) => u.port)),
      }),
      null,
      2,
    ) + '\n',
  );

  // The app's own env/*.json are kept; missing ones are empty (no made-up values).
  const created = generateFlutterEnvFiles(tree, name, {
    root: projectRoot,
    keepExisting: true,
    empty: true,
  });
  if (created.length > 0) {
    data.notes.push(
      `Created empty ${created.map((f) => `\`${f}\``).join(', ')}; existing env files were kept.`,
    );
  }

  addNpmScripts(tree, buildNpmScripts(name, { exportTarget: false }), { force: false });

  for (const gradle of ['android/app/build.gradle', 'android/app/build.gradle.kts']) {
    if (/\bproductFlavors\b/.test(readSourceText(sourceDir, gradle) ?? '')) {
      data.notes.push(
        `\`${gradle}\` defines product flavors. The build-* targets do not pass \`--flavor\`: ` +
          'build flavored variants with `flutter build … --flavor <name>` (or an `nx:run-commands` ' +
          'target) until the flutter-build executor supports it.',
      );
    }
  }
  const entrypoints = copy.copied.filter((f) => /^lib\/main_[^/]+\.dart$/.test(f)).sort();
  if (entrypoints.length > 0) {
    data.notes.push(
      `Extra entrypoints ${entrypoints.map((f) => `\`${f}\``).join(', ')}: the build-* targets ` +
        'build `lib/main.dart` and do not pass `-t`. Build the others with ' +
        '`flutter build … -t lib/main_<name>.dart` (or an `nx:run-commands` target).',
    );
  }

  const pubspec = readSourcePubspec(sourceDir);
  for (const dep of pubspec ? outsidePathDependencies(sourceDir, pubspec) : []) {
    data.notes.push(
      `pubspec.yaml ${dep.section}: \`${dep.name}\` has \`path: ${dep.path}\`, outside the source ` +
        'repo. It no longer resolves from `' +
        projectRoot +
        '`: move the package into the workspace (e.g. `pstack lib --type=flutter`) or fix the path.',
    );
  }

  data.nextSteps.push(
    `Fill \`${projectRoot}/env/<env>.json\` (dev, uat, prod); they are passed to Flutter with ` +
      '`--dart-define-from-file`',
    `\`cd ${projectRoot} && flutter pub get\``,
    `\`npx nx run ${name}:build-web:dev\``,
    `\`npx nx serve ${name}\``,
    '`pstack env --name=<env>` adds a new environment (env file and build configurations) to every app, this one included',
  );
  return data;
}
