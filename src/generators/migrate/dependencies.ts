import * as path from 'path';

import { GeneratorCallback, installPackagesTask, readJson, Tree, updateJson } from '@nx/devkit';

import { ensureAngularDependencies } from '../../lib/utils/angular-deps';
import {
  addMissingDependencies,
  declaredVersion,
  ensureReleaseHardeningDependencies,
  majorOf,
} from '../../lib/utils/dependencies';
import { rangesOverlap } from '../../lib/utils/devkit-deps';

import type { DependencyClash, MigrationReportData } from './adapters/types';
import type { SpecKind } from './npm-deps';
import { PackageJson, sourceDependency } from './source';

export interface AngularMismatch {
  workspace: string;
  source: string;
  workspaceMajor: number;
  sourceMajor: number;
}

/** Workspace and source @angular/core majors when they differ; undefined otherwise. */
export function angularMismatch(
  tree: Tree,
  pkg: PackageJson | undefined,
): AngularMismatch | undefined {
  const workspace = tree.exists('package.json')
    ? declaredVersion(tree, '@angular/core')
    : undefined;
  const source = sourceDependency(pkg, '@angular/core');
  if (!workspace || !source) return undefined;
  const workspaceMajor = majorOf(workspace);
  const sourceMajor = majorOf(source);
  if (workspaceMajor === undefined || sourceMajor === undefined) return undefined;
  return workspaceMajor === sourceMajor
    ? undefined
    : { workspace, source, workspaceMajor, sourceMajor };
}

/** The --force-angular refusal message. */
export function angularMismatchMessage(m: AngularMismatch): string {
  return (
    `the workspace uses Angular ${m.workspaceMajor} (@angular/core ${m.workspace}) but the ` +
    `source uses Angular ${m.sourceMajor} (@angular/core ${m.source}). Bring them to the same ` +
    'major first, or pass --force-angular to migrate anyway (the build may fail until the ' +
    'versions match).'
  );
}

/** Packages versioned with Angular itself. */
const ANGULAR_PACKAGE = /^(@angular\/|@angular-devkit\/|@angular-eslint\/|@schematics\/angular$)/;

const ANGULAR_BUILD_LINT = [
  '@angular-devkit/build-angular',
  '@angular/cli',
  '@angular/compiler-cli',
  '@nx/angular',
  '@nx/eslint',
  '@angular-eslint/eslint-plugin',
  '@angular-eslint/eslint-plugin-template',
  '@angular-eslint/template-parser',
];

/** Packages declared in dependencies, devDependencies or optionalDependencies. */
export function packageNames(tree: Tree): Set<string> {
  const pkg = readJson(tree, 'package.json');
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
}

/** Version declared in dependencies, devDependencies or optionalDependencies. */
function declaredAnywhere(tree: Tree, name: string): string | undefined {
  return declaredVersion(tree, name) ?? readJson(tree, 'package.json').optionalDependencies?.[name];
}

const PACKAGE_FIELDS: [keyof PackageJson, string][] = [
  ['overrides', 'not carried over'],
  ['resolutions', 'not carried over'],
  ['optionalDependencies', 'merged like devDependencies'],
  ['peerDependencies', 'not added'],
];

function recordPackageFields(pkg: PackageJson | undefined, data: MigrationReportData): void {
  for (const [field, handling] of PACKAGE_FIELDS) {
    const value = pkg?.[field];
    if (!value || typeof value !== 'object' || Object.keys(value).length === 0) continue;
    data.packageFields.push({
      field,
      handling,
      entries: Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    });
  }
}

export interface MergeInput {
  sourceDir: string;
  sourcePkg: PackageJson | undefined;
  /** How a file:/link:/relative spec is carried over. */
  classify: (spec: string) => SpecKind;
  /** Wording for "outside …" notes, e.g. "migrated project folder" or "copied projects". */
  copiedLabel: string;
  /** Make sure the Angular build/lint packages are there (false for Flutter-only imports). */
  angular: boolean;
  /** Source packages never carried over (e.g. the source's own Nx packages), with the reason. */
  skip?: DependencySkip | DependencySkip[];
}

/** Source packages left out of the root package.json, and why (for the report note). */
export interface DependencySkip {
  test: (pkgName: string) => boolean;
  reason: string;
}

/**
 * Source dependencies → root package.json, only the missing ones; then the build/lint packages
 * an Angular app needs in the workspace.
 */
export function mergeDependencies(
  tree: Tree,
  input: MergeInput,
  data: MigrationReportData,
): GeneratorCallback | undefined {
  const { sourcePkg } = input;
  if (!tree.exists('package.json')) tree.write('package.json', '{}\n');
  const workspaceCore = declaredVersion(tree, '@angular/core');
  const sourceCore = sourceDependency(sourcePkg, '@angular/core');
  const mismatch = angularMismatch(tree, sourcePkg);
  const before = packageNames(tree);

  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};
  const optionalDeps: Record<string, string> = {};
  const clashes: DependencyClash[] = [];
  const seen = new Set<string>();
  /** Source Angular packages not added because the workspace is on another Angular major. */
  const heldBack: string[] = [];
  const skipRules = input.skip === undefined ? [] : [input.skip].flat();
  const skipped = new Map<DependencySkip, string[]>();
  for (const [field, into] of [
    ['dependencies', deps],
    ['devDependencies', devDeps],
    ['optionalDependencies', optionalDeps],
  ] as const) {
    for (const [pkgName, sourceSpec] of Object.entries(sourcePkg?.[field] ?? {})) {
      if (seen.has(pkgName)) continue;
      seen.add(pkgName);
      const rule = skipRules.find((r) => r.test(pkgName));
      if (rule) {
        skipped.set(rule, [...(skipped.get(rule) ?? []), pkgName]);
        continue;
      }
      const local = input.classify(sourceSpec);
      if (local.kind === 'outside') {
        const inRepo = !path.relative(input.sourceDir, local.target).startsWith('..');
        data.notes.push(
          `Not added: \`${pkgName}\` (\`${sourceSpec}\`) points outside the ` +
            `${inRepo ? input.copiedLabel : 'source repo'}. Move that package into the ` +
            'workspace (e.g. as a lib) and depend on it from there.',
        );
        continue;
      }
      const version = local.kind === 'rebased' ? local.spec : sourceSpec;
      const declared = declaredAnywhere(tree, pkgName);
      if (declared === undefined && mismatch && ANGULAR_PACKAGE.test(pkgName)) {
        heldBack.push(pkgName);
      } else if (declared === undefined) into[pkgName] = version;
      else if (!rangesOverlap(declared, version)) {
        clashes.push({ name: pkgName, workspace: declared, source: version });
      }
    }
  }
  for (const [rule, names] of skipped) {
    data.notes.push(
      `Not added: ${names
        .sort()
        .map((p) => `\`${p}\``)
        .join(', ')} (${rule.reason}).`,
    );
  }
  const sourceTask = addMissingDependencies(tree, deps, devDeps);
  let optionalTask: GeneratorCallback | undefined;
  if (Object.keys(optionalDeps).length > 0) {
    updateJson(tree, 'package.json', (json) => {
      json.optionalDependencies = { ...(json.optionalDependencies ?? {}), ...optionalDeps };
      return json;
    });
    optionalTask = () => installPackagesTask(tree);
  }
  // includeRuntime: sources often list only some @angular/* packages (a lib-only package.json, or
  // a monorepo root that relied on hoisting); the compiler and platform packages a build needs
  // are filled in at the source's Angular version.
  // Migrated Angular apps get the release target, whose hardening loads terser.
  const hardeningTask = input.angular ? ensureReleaseHardeningDependencies(tree) : undefined;
  const angularTask = input.angular
    ? ensureAngularDependencies(tree, { includeRuntime: true }) ?? hardeningTask
    : undefined;
  recordPackageFields(sourcePkg, data);

  const after = packageNames(tree);
  data.dependenciesAdded = [...after].filter((n) => !before.has(n));
  data.dependencyClashes = clashes;

  if (mismatch) {
    data.angularNotes.push(
      `Angular major mismatch: the workspace has @angular/core \`${mismatch.workspace}\` ` +
        `(Angular ${mismatch.workspaceMajor}), the source had \`${mismatch.source}\` ` +
        `(Angular ${mismatch.sourceMajor}). Migrated with \`--force-angular\`; the workspace ` +
        'version was kept. Bring the app to the workspace major before building it.',
    );
    if (heldBack.length > 0) {
      data.angularNotes.push(
        `Not added (they would mix Angular majors): ${heldBack
          .sort()
          .map((p) => `\`${p}\``)
          .join(', ')}. Add them at the workspace's Angular version if the app needs them.`,
      );
    }
  } else if (!workspaceCore && sourceCore) {
    data.angularNotes.push(
      `The workspace had no Angular; the source's versions were added (@angular/core \`${sourceCore}\`).`,
    );
  } else if (workspaceCore && sourceCore) {
    data.angularNotes.push(
      `Same Angular major: workspace @angular/core \`${workspaceCore}\`, source \`${sourceCore}\`.`,
    );
  }
  const core = declaredVersion(tree, '@angular/core');
  const major = core ? majorOf(core) : undefined;
  if (input.angular && major !== undefined && major !== 15) {
    const missing = ANGULAR_BUILD_LINT.filter((p) => declaredVersion(tree, p) === undefined);
    if (missing.length > 0) {
      data.angularNotes.push(
        `nx-polystack adds the Angular build/lint packages automatically only for Angular 15. ` +
          `Install versions matching Angular ${major} for: ${missing
            .map((m) => `\`${m}\``)
            .join(', ')}.`,
      );
    }
  }
  return angularTask ?? sourceTask ?? optionalTask;
}
