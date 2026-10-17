import * as fs from 'fs';
import * as path from 'path';

import { installPackagesTask, Tree } from '@nx/devkit';

import { DependencySkip } from '../dependencies';
import { CAPACITOR_CONFIGS } from '../ionic/capacitor-config';
import { isWebCodeFile, nativeClassifier, packageOfSpecifier } from '../ionic/packages';
import { applyIonicShape, nativeImports } from '../ionic/shape';
import { withIonicSkip } from '../ionic/skip';
import { importSpecifiers } from '../nx/selection';
import { sourceRootPackage } from '../pnpm';
import { PackageJson, readSourcePackageJson, sourceDependency, sourceExists } from '../source';

import {
  ANGULAR_SKIP,
  ANGULAR_SKIP_NESTED,
  angularCliAdapter,
  detectAngularCli,
  migrateAngularApp,
} from './angular-cli';
import { Detection, MigrationAdapter, MigrationContext, MigrationReportData } from './types';

export function detectIonic(sourceDir: string): Detection {
  const pkg = readSourcePackageJson(sourceDir);
  const ionic = sourceDependency(pkg, '@ionic/angular');
  const config = CAPACITOR_CONFIGS.find((f) => sourceExists(sourceDir, f));
  if (!config && sourceExists(sourceDir, 'config.xml')) {
    return {
      confidence: 0,
      reasons: ['Cordova app (config.xml, no Capacitor config): migrate it to Capacitor first'],
    };
  }
  if (!ionic && !config) {
    return { confidence: 0, reasons: ['no @ionic/angular and no Capacitor config'] };
  }
  const angular = detectAngularCli(sourceDir);
  // angular-cli's own reasons without its Ionic cap; confidence 0 = not a single-app Angular CLI repo.
  const base = angular.reasons.filter((r) => !r.startsWith('Ionic/Capacitor app ('));
  if (angular.confidence === 0) return { confidence: 0, reasons: base };
  const reasons = [
    base[0],
    ionic
      ? `@ionic/angular ${ionic} in package.json`
      : 'no @ionic/angular (an Angular Capacitor app)',
  ];
  if (!config) {
    reasons.push(
      'no Capacitor config (only ionic.config.json): add Capacitor first (npx cap init)',
    );
    return { confidence: 0.5, reasons };
  }
  const capacitor = sourceDependency(pkg, '@capacitor/core');
  reasons.push(`${config}${capacitor ? ` (Capacitor ${capacitor})` : ' (no @capacitor/core)'}`);
  if (!capacitor) return { confidence: 0.8, reasons };
  return { confidence: ionic ? 0.95 : 0.9, reasons };
}

export interface IonicAppOptions {
  /** More source packages kept out of the root package.json. */
  extraSkip?: DependencySkip[];
  /** See AngularAppOptions. */
  ignoreFrom?: string;
  skipPaths?: string[];
  sourcePkg?: PackageJson;
  notesLabel?: string;
}

/** An Ionic/Capacitor Angular app (the ionic adapter, and Ionic packages of a workspace import). */
export function migrateIonic(
  tree: Tree,
  ctx: MigrationContext,
  opts: IonicAppOptions = {},
): MigrationReportData {
  const isNative = nativeClassifier(ctx.sourceDir);
  // The copy runs inside migrateAngularApp; which native packages the code imports is only known
  // after it, so the root merge keeps every native package the source code imports (checked on
  // the source files, which are the same as the copied ones).
  const imported = sourceNativeImports(ctx.sourceDir, isNative);
  const { data, releaseConfigurations } = migrateAngularApp(tree, ctx, {
    skip: withIonicSkip(ANGULAR_SKIP),
    skipNested: withIonicSkip(ANGULAR_SKIP_NESTED),
    ignoreFrom: opts.ignoreFrom,
    skipPaths: opts.skipPaths,
    sourcePkg: opts.sourcePkg,
    notesLabel: opts.notesLabel,
    dependencySkip: [
      ...(opts.extraSkip ?? []),
      {
        test: (name) => isNative(name) && !imported.has(name),
        reason: `native packages the code does not import; they are in \`${ctx.projectRoot}/package.json\``,
      },
    ],
    tags: ['scope:app', 'type:app', 'platform:mobile'],
  });
  const { report, installApp, rootPackagesAdded } = applyIonicShape(tree, {
    name: ctx.name,
    appRoot: ctx.projectRoot,
    sourcePkg: opts.sourcePkg ?? sourceRootPackage(ctx.sourceDir).pkg,
    isNative,
    alsoAtRoot: nativeImports(tree, ctx.projectRoot, isNative),
    releaseConfigurations,
  });
  data.ionic = [report];
  data.dependenciesAdded = [...new Set([...data.dependenciesAdded, ...rootPackagesAdded])].sort();
  const rootTask =
    data.installTask ??
    (rootPackagesAdded.length > 0 ? () => installPackagesTask(tree) : undefined);
  if (installApp) {
    data.installTask = async () => {
      if (rootTask) await rootTask();
      await installApp();
    };
  }
  data.nextSteps.push(
    `\`npx nx run ${ctx.name}:release:prod\``,
    `\`npx nx run ${ctx.name}:cap-sync --platform=android\` (and \`--platform=ios\`)`,
  );
  return data;
}

const SOURCE_SKIP = new Set(['node_modules', 'android', 'ios', 'dist', 'www', '.git', '.angular']);

/** Native packages imported by the source's code files (outside node_modules and native folders). */
function sourceNativeImports(sourceDir: string, isNative: (name: string) => boolean): Set<string> {
  const found = new Set<string>();
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const at = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SOURCE_SKIP.has(e.name)) visit(at);
      } else if (e.isFile() && isWebCodeFile(e.name)) {
        for (const spec of importSpecifiers(fs.readFileSync(at, 'utf8'))) {
          const pkg = packageOfSpecifier(spec);
          if (isNative(pkg)) found.add(pkg);
        }
      }
    }
  };
  visit(sourceDir);
  return found;
}

export const ionicAdapter: MigrationAdapter = {
  id: 'ionic',
  label: 'standalone Ionic or Capacitor Angular app',
  detect: detectIonic,
  defaultName(sourceDir: string): string | undefined {
    return readSourcePackageJson(sourceDir)?.name ?? angularCliAdapter.defaultName(sourceDir);
  },
  preflight: (tree, ctx) => angularCliAdapter.preflight?.(tree, ctx),
  migrate: (tree, ctx) => migrateIonic(tree, ctx),
};
