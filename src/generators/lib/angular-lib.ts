import * as path from 'path';

import { generateFiles, GeneratorCallback, names, Tree, writeJson } from '@nx/devkit';

import {
  ANGULAR_VERSION,
  CONTROL_FLOW_MAJOR,
  ensureAngularDependencies,
  ionicAngularImport,
  ionicStandaloneImport,
  ngPackagrDependencies,
  STANDALONE_FALSE_MAJOR,
  workspaceGeneratorMajor,
} from '../../lib/utils/angular-deps';
import { resolveAngularStyle } from '../../lib/utils/angular-style';
import {
  addMissingDependencies,
  declaredVersion,
  ensureLintDependencies,
} from '../../lib/utils/dependencies';

import {
  caretRange,
  combineTasks,
  lintTarget,
  NormalizedLibOptions,
  templateVars,
  writeLibProjectJson,
} from './lib-utils';

export const ANGULAR_LIB_VARIANTS = ['internal', 'buildable', 'publishable'] as const;

export interface AngularLibOptions {
  /** Template folder with the lib's own sources (src/…), rendered into the project root. */
  srcTemplates: string;
  /** Extra runtime packages the sources import, given the installed @angular/core version. */
  dependencies?: (angularCore: string) => Record<string, string>;
  /** Extra lib package.json peerDependencies, given the installed @angular/core version. */
  peerDependencies?: (tree: Tree, angularCore: string) => Record<string, string>;
  /** Build kind when --variant means something else for the type (e.g. state flavours). */
  build?: AngularLibBuild;
  /** Extra template substitutions. */
  vars?: Record<string, unknown>;
  /** Allowed component class suffixes for ESLint (default: the rule's own, "Component"). */
  componentSuffixes?: string[];
}

/** ng-packagr releases don't follow Angular patch numbers, so pin the major only. */
export function ngPackagrRange(angularCore: string | undefined): string {
  return ngPackagrDependencies(angularCore)['ng-packagr'];
}

export type AngularLibBuild = (typeof ANGULAR_LIB_VARIANTS)[number];

/**
 * Writes an Angular library: tsconfigs, ESLint config, project.json (lint + build per variant),
 * ng-package.json / package.json / tsconfig.lib.prod.json for buildable and publishable libs,
 * and the sources from `srcTemplates`. Adds the Angular, lint and ng-packagr packages it needs.
 * Shared by the angular and ionic types (and the Angular-based extras).
 */
export function writeAngularLib(
  tree: Tree,
  o: NormalizedLibOptions,
  opts: AngularLibOptions,
): GeneratorCallback | undefined {
  // Read before ensureAngularDependencies: a workspace without Angular gets 15 (no flag needed).
  const major = workspaceGeneratorMajor(tree);
  const standalone =
    resolveAngularStyle(tree, { standalone: o.standalone, module: o.module }, 'lib generator') ===
    'standalone';
  const vars = {
    ...templateVars(o),
    prefixCamel: names(o.prefix).propertyName,
    componentSuffixes: opts.componentSuffixes ?? null,
    standalone,
    // NgModule declarations on 19+ say standalone: false; standalone ones on 15–18 say true.
    standaloneFalse: !standalone && major >= STANDALONE_FALSE_MAJOR,
    standaloneTrue: standalone && major < STANDALONE_FALSE_MAJOR,
    ionicImport: ionicAngularImport(major),
    ionicStandaloneImport: ionicStandaloneImport(major),
    controlFlow: major >= CONTROL_FLOW_MAJOR,
    ...(opts.vars ?? {}),
  };
  const build = opts.build ?? (o.variant as AngularLibBuild);
  generateFiles(tree, path.join(__dirname, 'files', 'angular', 'config'), o.projectRoot, vars);
  generateFiles(tree, opts.srcTemplates, o.projectRoot, vars);
  if (standalone) {
    // Standalone libraries have no NgModules: components, directives and pipes are imported
    // directly and providers come from provide*() functions.
    for (const c of tree.listChanges()) {
      if (
        c.type !== 'DELETE' &&
        c.path.startsWith(`${o.projectRoot}/src/`) &&
        c.path.endsWith('.module.ts')
      ) {
        tree.delete(c.path);
      }
    }
  }

  const depsTask = combineTasks(ensureLintDependencies(tree), ensureAngularDependencies(tree));
  // ensureAngularDependencies adds Angular 15 when missing, so core is declared from here on
  // (unless the workspace has no package.json at all).
  const core = declaredVersion(tree, '@angular/core') ?? ANGULAR_VERSION;
  const packaged = build !== 'internal';

  const extraTask = addMissingDependencies(
    tree,
    { '@angular/common': core, ...(opts.dependencies?.(core) ?? {}) },
    packaged ? ngPackagrDependencies(core) : {},
  );

  const targets: Record<string, unknown> = {};
  if (packaged) {
    targets['build'] = {
      executor: build === 'publishable' ? '@nx/angular:package' : '@nx/angular:ng-packagr-lite',
      outputs: ['{workspaceRoot}/dist/{projectRoot}'],
      options: { project: `${o.projectRoot}/ng-package.json` },
      configurations: {
        production: { tsConfig: `${o.projectRoot}/tsconfig.lib.prod.json` },
        development: { tsConfig: `${o.projectRoot}/tsconfig.lib.json` },
      },
      defaultConfiguration: 'production',
    };
  }
  targets['lint'] = lintTarget(o, ['**/*.ts', '**/*.html']);

  writeLibProjectJson(tree, o, {
    sourceRoot: `${o.projectRoot}/src`,
    prefix: o.prefix,
    targets,
  });

  if (packaged) {
    writeJson(tree, `${o.projectRoot}/ng-package.json`, {
      $schema: `${o.offset}node_modules/ng-packagr/ng-package.schema.json`,
      dest: `${o.offset}dist/${o.projectRoot}`,
      lib: { entryFile: 'src/index.ts' },
    });
    writeJson(tree, `${o.projectRoot}/tsconfig.lib.prod.json`, {
      extends: './tsconfig.lib.json',
      compilerOptions: { declarationMap: false },
      angularCompilerOptions: { compilationMode: 'partial' },
    });
    // ng-packagr reads the package name and peers from here, so buildable libs need it too.
    const peer = caretRange(core, '^15.2.0');
    writeJson(tree, `${o.projectRoot}/package.json`, {
      name: o.importPath,
      version: '0.0.1',
      peerDependencies: {
        '@angular/common': peer,
        '@angular/core': peer,
        ...(opts.peerDependencies?.(tree, core) ?? {}),
      },
      dependencies: { tslib: '^2.3.0' },
      sideEffects: false,
    });
  }

  return combineTasks(depsTask, extraTask);
}
