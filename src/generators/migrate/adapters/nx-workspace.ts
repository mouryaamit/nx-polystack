import * as fs from 'fs';
import * as path from 'path';

import { GeneratorCallback, installPackagesTask, readJson, Tree, updateJson } from '@nx/devkit';

import { ngPackagrDependencies } from '../../../lib/utils/angular-deps';
import { noncePatchMains } from '../../../lib/utils/csp-nonce';
import {
  addMissingDependencies,
  declaredVersion,
  majorOf,
  nxVersion,
} from '../../../lib/utils/dependencies';
import { adoptHtaccess, htaccessNote } from '../../../lib/release/htaccess-adopt';
import { generateFlutterEnvFiles, moveFlutterEnvFiles } from '../../../lib/utils/env-files';
import { nodeRangeAllowsMajor, workspaceNodeMajor } from '../../../lib/utils/node-engine';
import { addNpmScripts } from '../../../lib/utils/npm-scripts';
import { nextFreePort, usedServePorts } from '../../../lib/utils/serve-port';
import { buildNpmScripts, buildProjectJson } from '../../app/generator';
import { addReleaseTarget, angularAppNpmScripts } from '../angular-project-json';
import { copyIntoTree, CopyResult, DEFAULT_MAX_FILES, isPossibleSecret, SkipRules } from '../copy';
import {
  angularMismatch,
  angularMismatchMessage,
  mergeDependencies,
  packageNames,
} from '../dependencies';
import {
  isWebCodeFile,
  nativeClassifier,
  packageOfSpecifier,
  PLATFORM_PACKAGES,
} from '../ionic/packages';
import { applyIonicShape } from '../ionic/shape';
import { withIonicSkip } from '../ionic/skip';
import { classifyDependencySpec, SpecKind } from '../npm-deps';
import { BuildScriptInfo, readBuildScripts } from '../nx/build-scripts';
import { detectNxWorkspace } from '../nx/detect';
import { applySourceEnvEncryption, swapEnvSecretModules } from '../nx/env-encryption';
import {
  eslintrcForFlatConfig,
  FLAT_ESLINT_FILE,
  FLAT_ESLINT_PACKAGE,
  workspaceUsesEslintrc,
} from '../nx/flat-eslint';
import {
  depConstraints,
  executorsOf,
  nxPluginPackage,
  outsidePaths,
  rewriteEslintConfig,
  rewriteProjectConfig,
} from '../nx/rewrite';
import { AliasMap, importSpecifiers, readSourceAliases, selectProjects } from '../nx/selection';
import {
  LIFECYCLE_SCRIPTS,
  RootFile,
  SharedFolder,
  SharedFolderFinder,
} from '../nx/shared-folders';
import {
  discoverProjects,
  isObject,
  listProjectFiles,
  isSupportedKind,
  Json,
  objectField,
  ownerOf,
  SourceProject,
  sourceNxVersion,
} from '../nx/workspace-source';
import { catalogMissMessage, sourceRootPackage } from '../pnpm';
import {
  parseJsonStrict,
  readSourceJson,
  readSourcePackageJson,
  readSourceText,
  sourceDependency,
  sourceExists,
} from '../source';

import { ANGULAR_SKIP_NESTED } from './angular-cli';
import { FLUTTER_SKIP } from './flutter';
import {
  emptyReportData,
  recordCopy,
  WorkspaceMigrationAdapter,
  WorkspaceMigrationContext,
  WorkspaceReportData,
} from './types';

interface PlannedProject {
  source: SourceProject;
  /** Name in the workspace. */
  name: string;
  /** Source names of the projects that need it; [] when selected. */
  neededBy: string[];
}

export interface NxImportPlan {
  all: SourceProject[];
  /** Sorted by root. */
  projects: PlannedProject[];
  renames: Map<string, string>;
  /** Source aliases whose targets are all inside copied projects. */
  copiedAliases: AliasMap;
  /** Source aliases of projects that are not copied. */
  otherAliases: string[];
}

const code = (s: string) => `\`${s}\``;
/** Kinds whose packages come from the source's root package.json. */
const NPM_KINDS = new Set(['angular-app', 'ionic-app', 'lib']);
const normalizePath = (p: string) => path.posix.normalize(p).replace(/^\.\//, '');

export function workspacePaths(tree: Tree): Record<string, string[]> {
  if (!tree.exists('tsconfig.base.json')) return {};
  const paths = readJson(tree, 'tsconfig.base.json')?.compilerOptions?.paths;
  if (!isObject(paths)) return {};
  return Object.fromEntries(
    Object.entries(paths).map(([alias, targets]) => [
      alias,
      Array.isArray(targets) ? targets.map((t) => normalizePath(String(t))) : [],
    ]),
  );
}

/** Selection, names and every check; throws (writing nothing) when something is in the way. */
export function planNxImport(tree: Tree, ctx: WorkspaceMigrationContext): NxImportPlan {
  const all = discoverProjects(ctx.sourceDir);
  const chosen = selectProjects({
    sourceDir: ctx.sourceDir,
    projects: all,
    requested: ctx.projects,
    noDeps: ctx.noDeps,
  });
  const renames = new Map<string, string>(
    [...chosen.keys()].map((n) => [n, ctx.prefix ? `${ctx.prefix}-${n}` : n]),
  );
  const byName = new Map(all.map((p) => [p.name, p]));
  const projects = [...chosen]
    .map(([n, neededBy]) => {
      const source = byName.get(n);
      if (!source) throw new Error(`migrate: unknown source project "${n}".`);
      return { source, name: renames.get(n) ?? n, neededBy };
    })
    .sort((a, b) => (a.source.root < b.source.root ? -1 : 1));

  const copied = projects.map((p) => p.source);
  const copiedAliases: AliasMap = {};
  const otherAliases: string[] = [];
  for (const [alias, targets] of Object.entries(readSourceAliases(ctx.sourceDir))) {
    const inside = (t: string) =>
      t.includes('*') ? copied.some((p) => wildcardCovers(t, p.root)) : !!ownerOf(copied, t);
    if (targets.length > 0 && targets.every(inside)) copiedAliases[alias] = targets;
    else otherAliases.push(alias);
  }

  const errors: string[] = [];
  const existing = new Set(treeProjectNames(tree));
  for (const p of projects) {
    if (tree.exists(p.source.root)) {
      errors.push(
        `${code(p.source.root)} already exists in the workspace (source project ${p.source.name}).`,
      );
    }
    if (existing.has(p.name)) {
      errors.push(
        `a project named "${p.name}" already exists in the workspace.` +
          (ctx.prefix ? '' : ' Rename the migrated projects with --prefix=<p>.'),
      );
    }
  }
  const wsPaths = workspacePaths(tree);
  for (const [alias, targets] of Object.entries(copiedAliases)) {
    const ws = wsPaths[alias];
    if (ws && JSON.stringify(ws) !== JSON.stringify(targets)) {
      errors.push(
        `the path alias "${alias}" maps to ${ws.join(', ')} in the workspace but to ` +
          `${targets.join(', ')} in the source; imports would resolve to the wrong code.`,
      );
    }
  }
  const npmProjects = projects.some((p) => NPM_KINDS.has(p.source.kind));
  const rootPkg = sourceRootPackage(ctx.sourceDir);
  if (rootPkg.unresolved.length > 0) {
    errors.push(catalogMissMessage('the source root package.json', rootPkg.unresolved));
  }
  const mismatch = angularMismatch(tree, rootPkg.pkg);
  if (mismatch && npmProjects && !ctx.forceAngular) errors.push(angularMismatchMessage(mismatch));
  if (errors.length > 0) {
    throw new Error(
      [
        `migrate: cannot import from ${ctx.sourceDir}. Nothing was written.`,
        ...errors.map((e) => `- ${e}`),
      ].join('\n'),
    );
  }
  return { all, projects, renames, copiedAliases, otherAliases: otherAliases.sort() };
}

/** A wildcard alias target (with a `*` segment) that can resolve inside `root`. */
function wildcardCovers(target: string, root: string): boolean {
  const prefix = target.slice(0, target.indexOf('*'));
  return root.startsWith(prefix) || `${root}/`.startsWith(prefix) || prefix.startsWith(`${root}/`);
}

const WALK_SKIP = new Set(['node_modules', 'dist', 'tmp', 'coverage']);

/** Names of every project in the workspace tree (project.json `name`, else the folder name). */
export function treeProjectNames(tree: Tree): string[] {
  const names: string[] = [];
  const visit = (dir: string) => {
    for (const child of tree.children(dir)) {
      const rel = dir ? `${dir}/${child}` : child;
      if (child === 'project.json' && tree.isFile(rel)) {
        let name: unknown;
        try {
          name = readJson(tree, rel)?.name;
        } catch {
          name = undefined;
        }
        names.push(typeof name === 'string' ? name : path.posix.basename(dir));
      } else if (!tree.isFile(rel) && !WALK_SKIP.has(child) && !child.startsWith('.')) {
        visit(rel);
      }
    }
  };
  visit('');
  return names;
}

const NX_IMPORT = /^@(nrwl|nx)\/([^/]+)/;
const CODE_FILE = /\.(ts|tsx|mts|js|mjs|cjs)$/;

const schemaPath = (root: string) =>
  `${'../'.repeat(root.split('/').length)}node_modules/nx/schemas/project-schema.json`;
const writeJson = (tree: Tree, file: string, value: unknown) =>
  tree.write(file, JSON.stringify(value, null, 2) + '\n');
const ESLINTRC = /(^|\/)\.eslintrc\.json$/;
const TOO_MANY = 'migrate: the source has more than';

export function dependencyFields(tree: Tree): string {
  const pkg = readJson(tree, 'package.json');
  return JSON.stringify([pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]);
}

/** file:/link: specs keep their path when they point into a copied project. */
export function classifyWorkspaceSpec(spec: string, sourceDir: string, roots: string[]): SpecKind {
  const kind = classifyDependencySpec(spec, { sourceDir, copiedDir: sourceDir, projectRoot: '' });
  if (kind.kind !== 'rebased') return kind;
  const rel = kind.spec.slice('file:'.length);
  return roots.some((r) => rel === r || rel.startsWith(`${r}/`))
    ? kind
    : { kind: 'outside', target: path.join(sourceDir, rel) };
}

function copyProject(
  tree: Tree,
  ctx: WorkspaceMigrationContext,
  plan: NxImportPlan,
  p: PlannedProject,
  alreadyCopied: number,
): CopyResult {
  const { root, kind } = p.source;
  const nested = plan.all
    .map((o) => o.root)
    .filter((r) => r !== root && r.startsWith(`${root}/`))
    .map((r) => r.slice(root.length + 1));
  const base =
    kind === 'flutter-app' || kind === 'flutter-lib'
      ? FLUTTER_SKIP
      : kind === 'ionic-app'
      ? withIonicSkip(ANGULAR_SKIP_NESTED)
      : ANGULAR_SKIP_NESTED;
  const rules: SkipRules = { ...base, paths: [...(base.paths ?? []), ...nested] };
  const maxFiles = ctx.maxFiles ?? DEFAULT_MAX_FILES;
  try {
    return copyIntoTree(tree, path.join(ctx.sourceDir, ...root.split('/')), root, rules, {
      ignoreFrom: ctx.sourceDir,
      maxFiles: maxFiles - alreadyCopied,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(TOO_MANY)) {
      throw new Error(
        `migrate: the selected projects have more than ${maxFiles} files to copy after the skip ` +
          'lists. Narrow --projects, clean up the source, or raise --max-files.',
      );
    }
    throw err;
  }
}

function migrateNxWorkspace(tree: Tree, ctx: WorkspaceMigrationContext): WorkspaceReportData {
  const plan = planNxImport(tree, ctx);
  const { sourceDir } = ctx;
  const data: WorkspaceReportData = { ...emptyReportData(), projects: [], unsupported: [] };
  const roots = plan.projects.map((p) => p.source.root);
  const pluginPackages = new Set<string>();
  const usedInputs = new Set<string>();
  let usesJest = false;
  let usesNgPackagr = false;
  if (!tree.exists('package.json')) writeJson(tree, 'package.json', {});
  const depsBefore = dependencyFields(tree);
  const namesBefore = packageNames(tree);
  const isNative = nativeClassifier(sourceDir);
  /** Native packages each copied project's code imports. */
  const nativeImportsOf = new Map<string, Set<string>>();
  const ionicApps: { p: PlannedProject; releases: string[] }[] = [];
  const sourcePkg = sourceRootPackage(sourceDir).pkg;
  const npmProjects = plan.projects.some((p) => NPM_KINDS.has(p.source.kind));

  // A workspace on .eslintrc.json (ESLint 8) does not take the source's flat config: a root
  // eslint.config.js would switch every project's lint to it.
  const eslintrc = workspaceUsesEslintrc(tree);
  // Folders the projects use that are not projects (assets, styles, environments, tools).
  let shared = findSharedFolders(ctx, plan, npmProjects ? sourcePkg?.scripts : undefined);
  if (eslintrc && shared.rootFiles.some((f) => FLAT_ESLINT_FILE.test(f.path))) {
    const flat = shared.rootFiles.filter((f) => FLAT_ESLINT_FILE.test(f.path)).map((f) => f.path);
    shared = { ...shared, rootFiles: shared.rootFiles.filter((f) => !flat.includes(f.path)) };
    data.notes.push(
      `Not copied: ${flat.map(code).join(', ')} (ESLint flat config). The workspace lints with ` +
        '`.eslintrc.json`, so the copied projects get `.eslintrc.json` files instead.',
    );
  }
  copySharedFolders(tree, ctx, shared, data);
  const buildScripts = readBuildScripts(
    sourceDir,
    npmProjects ? sourcePkg?.scripts : undefined,
    plan.projects.map((p) => p.source.name),
  );
  const mains: string[] = [];

  for (const p of plan.projects) {
    const { root, kind } = p.source;
    const copy = copyProject(tree, ctx, plan, p, data.copied);
    recordCopy(data, copy, root);

    const dropped = new Set<string>();
    let config = rewriteProjectConfig(p.source.config, p.name, plan.renames, (n) => dropped.add(n));
    if (p.source.origin !== 'project.json') {
      const rest: Json = { ...config };
      delete rest['name'];
      delete rest['root'];
      delete rest['$schema'];
      config = { name: config['name'], $schema: schemaPath(root), ...rest };
    }
    if (!isObject(config['targets'])) config['targets'] = {};
    const targets = config['targets'] as Json;
    const tags = Array.isArray(config['tags']) ? [...(config['tags'] as string[])] : [];
    const addTag = (prefix: string, tag: string) => {
      if (!tags.some((t) => t.startsWith(prefix))) tags.push(tag);
    };
    const notes: string[] = [];
    let releaseAdded = false;

    if (kind === 'angular-app' || kind === 'ionic-app') {
      const releases = addReleaseTarget(targets, p.name, (w) => notes.push(w), root);
      releaseAdded = releases.length > 0;
      // Only the release target this run added; a source's own release target stays as it was.
      if (releases.length > 0) shapeReleaseTarget(targets, p, buildScripts, notes);
      const main = mainOf(targets);
      if (main) mains.push(main);
      addTag('type:', 'type:app');
      addTag('platform:', kind === 'ionic-app' ? 'platform:mobile' : 'platform:web');
      // The source's own scripts of the same name (custom build pipelines) win.
      const appScripts = angularAppNpmScripts(p.name, targets['serve'] !== undefined, releases);
      for (const k of Object.keys(npmProjects ? sourcePkg?.scripts ?? {} : {}))
        delete appScripts[k];
      addNpmScripts(tree, appScripts, { force: false });
      data.nextSteps.push(`\`npx nx build ${p.name}\``);
      if (kind === 'ionic-app') ionicApps.push({ p, releases });
    } else if (kind === 'lib') {
      addTag('type:', 'type:lib');
    } else if (kind === 'flutter-app') {
      const polystack = (
        buildProjectJson(p.name, {
          exportTarget: false,
          root,
          port: nextFreePort(usedServePorts(tree).map((u) => u.port)),
          htaccess: false,
        }) as { targets: Json }
      ).targets;
      // A clean target of the source is kept.
      if (targets['clean'] !== undefined) delete polystack['clean'];
      const replaced = Object.keys(polystack)
        .filter((t) => targets[t] !== undefined)
        .sort();
      Object.assign(targets, polystack);
      if (replaced.length > 0) {
        notes.push(
          `source targets replaced by the polystack Flutter targets: ${replaced.join(', ')}`,
        );
      }
      addTag('type:', 'type:app');
      addTag('platform:', 'platform:flutter');
      const moved = moveFlutterEnvFiles(tree, root, p.name);
      if (moved.moved.length > 0) {
        notes.push(`env files moved to ${code(`environments/${p.name}/`)}`);
      }
      const created = generateFlutterEnvFiles(tree, p.name, { keepExisting: true, empty: true });
      if (created.length > 0) {
        notes.push(
          `created empty ${created.map(code).join(', ')}; fill them (they are passed to Flutter ` +
            'with `--dart-define-from-file`)',
        );
      }
      addNpmScripts(tree, buildNpmScripts(p.name, { exportTarget: false }), { force: false });
      data.nextSteps.push(
        `\`cd ${root} && flutter pub get\``,
        `\`npx nx run ${p.name}:build-web:dev\``,
      );
    }
    config['tags'] = tags;

    for (const executor of executorsOf(config)) {
      const pkg = nxPluginPackage(executor);
      if (pkg) pluginPackages.add(pkg);
      if (executor === '@nx/jest:jest') usesJest = true;
      if (/^@nx\/angular:(package|ng-packagr-lite)$/.test(executor)) usesNgPackagr = true;
    }
    for (const input of namedInputsOf(targets)) usedInputs.add(input);
    writeJson(tree, `${root}/project.json`, config);
    if (releaseAdded) htaccessNote(adoptHtaccess(tree, `${root}/project.json`), p.name, notes);
    // Env files inside the project (apps and libraries) go to environments/<name>/.
    if (kind !== 'flutter-app') {
      (data.envMoves ??= []).push({
        projectJson: `${root}/project.json`,
        envProject: p.name,
        label: code(p.name),
      });
    }
    if (dropped.size > 0) {
      notes.push(
        `dropped references to projects that were not copied: ${[...dropped]
          .sort()
          .map(code)
          .join(', ')} (implicitDependencies / dependsOn); Nx fails on unknown projects`,
      );
    }
    const nrwlImports: string[] = [];
    for (const f of copy.copied.filter((c) => CODE_FILE.test(c))) {
      const text = tree.read(`${root}/${f}`, 'utf8') ?? '';
      let nrwl = false;
      for (const spec of importSpecifiers(text)) {
        const pkgName = packageOfSpecifier(spec);
        if (isWebCodeFile(f) && isNative(pkgName)) {
          const set = nativeImportsOf.get(p.name) ?? new Set<string>();
          set.add(pkgName);
          nativeImportsOf.set(p.name, set);
        }
        const m = NX_IMPORT.exec(spec);
        if (!m) continue;
        pluginPackages.add(`@nx/${m[2]}`);
        if (m[1] === 'nrwl') nrwl = true;
      }
      if (nrwl) nrwlImports.push(`${root}/${f}`);
    }
    if (nrwlImports.length > 0 && !ctx.rewriteImports) {
      notes.push(
        `these files import \`@nrwl/*\` packages; rename the imports to \`@nx/*\`: ` +
          nrwlImports.map(code).join(', '),
      );
    }
    if (kind === 'flutter-app' && !/^apps\/[^/]+$/.test(root)) {
      notes.push(
        `\`pstack env\` only updates apps directly under \`apps/\`; add new env files to ` +
          `${code(`${root}/env`)} and configurations to its build targets by hand`,
      );
    }
    if (eslintrc) {
      const converted = convertFlatEslint(tree, root, copy.copied);
      if (converted.length > 0) {
        notes.push(
          `its ESLint flat config (${converted.map(code).join(', ')}) was replaced by ` +
            `${code(`${root}/.eslintrc.json`)} (the workspace's format, Nx defaults and the ` +
            'selector prefixes); add any custom rules it had',
        );
      }
    }
    for (const f of copy.copied.filter((c) => ESLINTRC.test(c))) {
      const file = `${root}/${f}`;
      writeJson(
        tree,
        file,
        rewriteEslintConfig(parseJsonStrict<Json>(tree.read(file, 'utf8') ?? '', file)),
      );
    }
    if (targets['lint'] !== undefined) data.nextSteps.push(`\`npx nx lint ${p.name}\``);

    const outside = outsidePaths(
      config,
      roots,
      (first) => sourceExists(sourceDir, first) || tree.exists(first),
    ).filter((o) => !tree.exists(o));
    if (outside.length > 0) {
      notes.push(
        `options point outside the copied projects, at paths the workspace does not have: ` +
          `${outside.map(code).join(', ')}. Copy them or change the options.`,
      );
    }
    data.notes.push(...notes.map((n) => `${code(p.name)}: ${n}`));
    data.projects.push({
      name: p.name,
      sourceName: p.source.name,
      kind,
      root,
      why:
        p.neededBy.length === 0
          ? 'selected'
          : `needed by ${p.neededBy.map((n) => plan.renames.get(n) ?? n).join(', ')}`,
    });
  }

  data.unsupported = plan.all
    .filter((p) => !isSupportedKind(p.kind))
    .map((p) => ({ name: p.name, kind: p.kind, root: p.root || '.' }));

  // tsconfig.base.json: aliases of copied projects, as they were.
  const aliasNames = Object.keys(plan.copiedAliases).sort();
  if (aliasNames.length > 0) {
    if (!tree.exists('tsconfig.base.json'))
      writeJson(tree, 'tsconfig.base.json', { compilerOptions: {} });
    updateJson(tree, 'tsconfig.base.json', (json) => {
      const co = json.compilerOptions ?? {};
      const paths = { ...(co.paths ?? {}) };
      for (const alias of aliasNames) {
        if (paths[alias] !== undefined) continue;
        paths[alias] = plan.copiedAliases[alias];
        data.tsPathsAdded.push(alias);
      }
      json.compilerOptions = { ...co, paths };
      return json;
    });
  }
  if (plan.otherAliases.length > 0) {
    data.notes.push(
      `Path aliases of projects that were not copied (not added): ${plan.otherAliases
        .map(code)
        .join(', ')}.`,
    );
  }
  const sourceTs = readSourceJson<Json>(sourceDir, 'tsconfig.base.json');
  const sourceCo = objectField(sourceTs, 'compilerOptions');
  const workspaceCo = (
    tree.exists('tsconfig.base.json')
      ? readJson(tree, 'tsconfig.base.json').compilerOptions ?? {}
      : {}
  ) as Json;
  // Options the workspace base does not set are added, so the copied code compiles as before
  // (allowJs for imported .js files, strict: false, …); options it sets differently are listed.
  const NOT_CARRIED = new Set(['paths', 'baseUrl', 'rootDir', 'outDir']);
  const missing = Object.keys(sourceCo)
    .filter((k) => !NOT_CARRIED.has(k) && workspaceCo[k] === undefined)
    .sort();
  const differing = Object.keys(sourceCo)
    .filter((k) => !NOT_CARRIED.has(k) && workspaceCo[k] !== undefined)
    .filter((k) => JSON.stringify(sourceCo[k]) !== JSON.stringify(workspaceCo[k]))
    .sort();
  const sourceNg = objectField(sourceTs, 'angularCompilerOptions');
  const workspaceNg = (
    tree.exists('tsconfig.base.json')
      ? readJson(tree, 'tsconfig.base.json').angularCompilerOptions ?? {}
      : {}
  ) as Json;
  const missingNg = Object.keys(sourceNg)
    .filter((k) => workspaceNg[k] === undefined)
    .sort();
  if ((missing.length > 0 || missingNg.length > 0) && tree.exists('tsconfig.base.json')) {
    updateJson(tree, 'tsconfig.base.json', (json) => {
      json.compilerOptions = { ...(json.compilerOptions ?? {}) };
      for (const k of missing) json.compilerOptions[k] = sourceCo[k];
      if (missingNg.length > 0) {
        json.angularCompilerOptions = { ...(json.angularCompilerOptions ?? {}) };
        for (const k of missingNg) json.angularCompilerOptions[k] = sourceNg[k];
      }
      return json;
    });
    data.notes.push(
      'Added to `tsconfig.base.json` from the source (the workspace did not set them): ' +
        [
          ...missing.map((k) => code(`${k}: ${JSON.stringify(sourceCo[k])}`)),
          ...missingNg.map((k) =>
            code(`angularCompilerOptions.${k}: ${JSON.stringify(sourceNg[k])}`),
          ),
        ].join(', ') +
        '. They apply to every project of the workspace.',
    );
  }
  if (differing.length > 0) {
    data.notes.push(
      'The source `tsconfig.base.json` sets compilerOptions the workspace has with other ' +
        `values: ${differing
          .map((k) => code(`${k}: ${JSON.stringify(sourceCo[k])}`))
          .join(', ')}. ` +
        "The workspace values were kept; set them in the projects' tsconfig files if the code " +
        'needs them.',
    );
  }

  // package.json: only when npm projects were copied.
  const ionicNames = new Set(ionicApps.map((a) => a.p.name));
  const importedAnywhere = new Set([...nativeImportsOf.values()].flatMap((s) => [...s]));
  const importedByShared = new Set(
    [...nativeImportsOf].filter(([n]) => !ionicNames.has(n)).flatMap(([, set]) => [...set]),
  );
  data.npmProject = plan.projects.some((p) => NPM_KINDS.has(p.source.kind));
  if (data.npmProject) {
    mergeDependencies(
      tree,
      {
        sourceDir,
        sourcePkg,
        classify: (spec) => classifyWorkspaceSpec(spec, sourceDir, roots),
        copiedLabel: 'copied projects',
        angular: sourceDependency(sourcePkg, '@angular/core') !== undefined,
        skip: [
          {
            test: (pkgName) =>
              /^(@nrwl\/|@nx\/|@nxext\/|nx$)/.test(pkgName) ||
              (ionicApps.length > 0 && isNative(pkgName) && !importedAnywhere.has(pkgName)),
            reason:
              ionicApps.length > 0
                ? "the source's Nx packages (the workspace keeps its own Nx version) and native " +
                  "packages no copied code imports (they are in the Ionic apps' own package.json)"
                : "the source's Nx packages; the workspace keeps its own Nx version",
          },
          ...(eslintrc
            ? [
                {
                  test: (pkgName: string) => FLAT_ESLINT_PACKAGE.test(pkgName),
                  reason:
                    "the source's ESLint flat-config packages; the workspace lints with " +
                    '`.eslintrc.json` and its own ESLint and typescript-eslint',
                },
              ]
            : []),
        ],
      },
      data,
    );
    data.sourceScripts = carryRootPackageFields(tree, sourcePkg, data, scriptContext(plan));
  }
  const nonceNote = noncePatchMains(tree, mains);
  if (nonceNote) data.notes.push(nonceNote);
  // The source's own env encryption: same output from the release build, library runtime module.
  const envEncryption = applySourceEnvEncryption(
    tree,
    sourceDir,
    data.notes,
    plan.projects.map((p) => p.source.root),
  );
  swapEnvSecretModules(
    tree,
    [...plan.projects.map((p) => p.source.root), ...shared.folders.map((f) => f.path)],
    data.notes,
    sourceDir,
  );
  noteBuildScripts(buildScripts, data, envEncryption?.applied === true);
  if (shared.usedBaseUrl) baseUrlForImports(tree, sourceDir, data);

  // Ionic apps: after every project.json is written and the root merge ran.
  const installApps: GeneratorCallback[] = [];
  if (ionicApps.length > 0) data.ionic = [];
  for (const { p, releases } of ionicApps) {
    const { report, installApp } = applyIonicShape(tree, {
      name: p.name,
      appRoot: p.source.root,
      sourcePkg,
      isNative,
      // Several Ionic apps: each gets the platform packages, what it or the shared code imports,
      // and what no copied code imports.
      forThisApp:
        ionicApps.length > 1
          ? (n) =>
              PLATFORM_PACKAGES.has(n) ||
              (nativeImportsOf.get(p.name)?.has(n) ?? false) ||
              importedByShared.has(n) ||
              !importedAnywhere.has(n)
          : undefined,
      alsoAtRoot: importedAnywhere,
      releaseConfigurations: releases,
    });
    data.ionic?.push(report);
    if (installApp) installApps.push(installApp);
    data.nextSteps.push(
      `\`npx nx run ${p.name}:release:prod\``,
      `\`npx nx run ${p.name}:cap-sync --platform=android\``,
    );
  }
  const nx = nxVersion(tree);
  addMissingDependencies(
    tree,
    {},
    Object.fromEntries([...pluginPackages].sort().map((pkg) => [pkg, nx])),
  );

  if (usesNgPackagr) {
    addMissingDependencies(tree, {}, ngPackagrDependencies(declaredVersion(tree, '@angular/core')));
  }
  addNamedInputs(tree, sourceDir, usedInputs, data);

  if (usesJest) {
    const sourceJest = sourceDependency(sourcePkg, 'jest');
    const jestMajor = sourceJest ? majorOf(sourceJest) : undefined;
    if (jestMajor !== undefined && jestMajor < 29) {
      data.notes.push(
        `The source used Jest ${sourceJest}; the workspace's \`@nx/jest\` ${nxVersion(tree)} ` +
          'needs Jest 29. Update `jest`, `jest-environment-jsdom`, `ts-jest` and `@types/jest` to ' +
          '29, and `jest-preset-angular` to 13 (Angular 15), before running the tests.',
      );
    }
    for (const file of ['jest.preset.js', 'jest.config.ts']) {
      if (tree.exists(file)) continue;
      const text = readSourceText(sourceDir, file);
      if (text === undefined || (file === 'jest.config.ts' && !text.includes('getJestProjects'))) {
        continue;
      }
      tree.write(file, text.replace(/@nrwl\/jest/g, '@nx/jest'));
      data.notes.push(
        `Copied ${code(file)} from the source (the copied projects' Jest configs use it).`,
      );
    }
  }

  const rootEslint = readSourceJson<Json>(sourceDir, '.eslintrc.json');
  const constraints = rootEslint ? depConstraints(rootEslint) : [];
  if (constraints.length > 0) {
    data.notes.push(
      "The source's root ESLint config was not copied. Its module-boundary rules " +
        `(\`depConstraints\`) were: ${constraints.map(code).join(', ')}. Add the ones you want ` +
        'to the workspace `.eslintrc.json`.',
    );
  }

  // Nx 18+ can infer targets from nx.json plugins; those targets are not in project.json.
  const plugins = inferencePlugins(readSourceJson<Json>(sourceDir, 'nx.json'));
  if (plugins.length > 0) {
    data.notes.push(
      `The source's nx.json infers targets with plugins (${plugins.map(code).join(', ')}). ` +
        'Inferred targets are not in project.json, so they were not copied: add them to the ' +
        "migrated projects' project.json (or the plugins to the workspace nx.json).",
    );
  }

  const sourceNx = sourceNxVersion(sourceDir);
  const workspaceNx = declaredVersion(tree, 'nx');
  if (sourceNx && workspaceNx && majorOf(sourceNx) !== majorOf(workspaceNx)) {
    data.notes.push(
      `The source used Nx ${sourceNx}; the workspace has Nx ${workspaceNx}. \`@nrwl/*\` ` +
        'executors were renamed to `@nx/*`; check each target with `npx nx show project <name>`.',
    );
  }

  data.nextSteps.push(
    '`pstack env --name=<env>` adds an environment to every app; migrated Angular apps keep ' +
      'their own environment files and fileReplacements',
  );
  // Everything this run added (source dependencies, @nx plugins, build packages), sorted.
  data.dependenciesAdded = [...packageNames(tree)].filter((n) => !namesBefore.has(n)).sort();
  const rootInstall =
    dependencyFields(tree) !== depsBefore ? () => installPackagesTask(tree) : undefined;
  data.installTask =
    rootInstall || installApps.length > 0
      ? async () => {
          if (rootInstall) rootInstall();
          for (const install of installApps) await install();
        }
      : undefined;
  return data;
}

/** A named input reference: not a file set ({…}), negation, path or dependency object. */
function inputName(entry: unknown): string | undefined {
  if (typeof entry !== 'string') return undefined;
  const name = entry.replace(/^\^/, '');
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : undefined;
}

/** Named inputs referenced by the targets' `inputs`. */
function namedInputsOf(targets: Json): string[] {
  const out: string[] = [];
  for (const target of Object.values(targets)) {
    const inputs = isObject(target) ? target['inputs'] : undefined;
    if (!Array.isArray(inputs)) continue;
    for (const entry of inputs) {
      const name = inputName(entry);
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * Named inputs the copied targets use but the workspace nx.json lacks: copied from the source
 * nx.json (with the ones they refer to), the rest listed.
 */
function addNamedInputs(
  tree: Tree,
  sourceDir: string,
  used: Set<string>,
  data: WorkspaceReportData,
): void {
  if (used.size === 0) return;
  const workspaceNx = tree.exists('nx.json') ? readJson(tree, 'nx.json') : {};
  const workspaceNamed = (isObject(workspaceNx.namedInputs) ? workspaceNx.namedInputs : {}) as Json;
  const sourceNx = readSourceJson<Json>(sourceDir, 'nx.json');
  const sourceNamed = objectField(sourceNx, 'namedInputs');
  const added: Json = {};
  const unknown = new Set<string>();
  const queue = [...used];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (workspaceNamed[name] !== undefined || added[name] !== undefined || unknown.has(name)) {
      continue;
    }
    const definition = sourceNamed[name];
    if (definition === undefined) {
      unknown.add(name);
      continue;
    }
    added[name] = definition;
    if (Array.isArray(definition)) {
      for (const entry of definition) {
        const ref = inputName(entry);
        if (ref) queue.push(ref);
      }
    }
  }
  const addedNames = Object.keys(added).sort();
  if (addedNames.length > 0) {
    if (!tree.exists('nx.json')) writeJson(tree, 'nx.json', {});
    updateJson(tree, 'nx.json', (json) => {
      json.namedInputs = { ...(json.namedInputs ?? {}), ...added };
      return json;
    });
    data.notes.push(
      `Added named inputs to \`nx.json\`: ${addedNames.map(code).join(', ')} (from the source, ` +
        'used by the copied targets).',
    );
  }
  if (unknown.size > 0) {
    data.notes.push(
      'The copied targets use named inputs that neither `nx.json` defines: ' +
        `${[...unknown].sort().map(code).join(', ')}. Define them under \`namedInputs\` in ` +
        '`nx.json`, or remove them from the targets.',
    );
  }
}

export const nxWorkspaceAdapter: WorkspaceMigrationAdapter = {
  kind: 'workspace',
  id: 'nx-workspace',
  label: 'Nx workspace (Angular, Ionic and Flutter projects)',
  detect: detectNxWorkspace,
  defaultName(sourceDir: string): string | undefined {
    const name = readSourcePackageJson(sourceDir)?.name;
    return name ? name.replace(/^@[^/]+\//, '') : path.basename(sourceDir);
  },
  preflight(tree: Tree, ctx: WorkspaceMigrationContext): void {
    planNxImport(tree, ctx);
  },
  migrate: migrateNxWorkspace,
};

// ── Shared folders, release targets and root package.json (multi-app sources) ──────────────────

const SHARED_SKIP: SkipRules = { anyDepth: ['node_modules', '.git'], topLevel: [] };

/** Folders the selected projects use that are not projects (found from options, code, scripts). */
interface SharedFinding {
  folders: SharedFolder[];
  rootFiles: RootFile[];
  /** A baseUrl-style import (`environments/x`) was found. */
  usedBaseUrl: boolean;
  /** Projects not selected that copied code or options reach into: root → why. */
  unselected: [string, string[]][];
}

function findSharedFolders(
  ctx: WorkspaceMigrationContext,
  plan: NxImportPlan,
  scripts: Record<string, string> | undefined,
): SharedFinding {
  const { sourceDir } = ctx;
  const sourceTs = readSourceJson<Json>(sourceDir, 'tsconfig.base.json');
  const baseUrl = objectField(sourceTs, 'compilerOptions')['baseUrl'];
  const baseUrlRoot = baseUrl === '.' || baseUrl === './';
  const finder = new SharedFolderFinder({
    sourceDir,
    projectRoots: plan.all.map((p) => p.root),
    selectedRoots: plan.projects.map((p) => p.source.root),
  });
  const scanCode = (root: string) => {
    for (const file of listProjectFiles(sourceDir, root)) {
      if (!(CODE_FILE.test(file) || STYLE_FILE.test(file)) || file.endsWith('.d.ts')) continue;
      const full = root ? `${root}/${file}` : file;
      const text = readSourceText(sourceDir, full);
      if (text !== undefined) finder.addCode(full, text, baseUrlRoot);
    }
  };
  for (const p of plan.projects) {
    finder.addProjectConfig(p.source.name, p.source.config);
    scanCode(p.source.root);
  }
  finder.addTsconfig(sourceTs);
  finder.addScripts(scripts);
  // Shared folders may import further ones (an env file importing a config folder).
  const scanned = new Set<string>();
  for (let round = 0; round < 3; round++) {
    const next = finder.folders().filter((f) => !scanned.has(f.path));
    if (next.length === 0) break;
    for (const f of next) {
      scanned.add(f.path);
      scanCode(f.path);
    }
  }
  return {
    folders: finder.folders(),
    rootFiles: finder.rootFiles(),
    usedBaseUrl: finder.usedBaseUrl,
    unselected: finder.unselectedReferences(),
  };
}

const STYLE_FILE = /\.(scss|sass|css|less)$/;

function copySharedFolders(
  tree: Tree,
  ctx: WorkspaceMigrationContext,
  finding: SharedFinding,
  data: WorkspaceReportData,
): void {
  copyRootFiles(tree, ctx, finding.rootFiles, data);
  // Code imports into those projects are reported by the import rewriting; options are not.
  const unselected = finding.unselected
    .map(([root, why]): [string, string[]] => [
      root,
      why.filter((w) => !w.startsWith('imported by')),
    ])
    .filter(([, why]) => why.length > 0);
  if (unselected.length > 0) {
    data.notes.push(
      `Options of the copied projects reach into projects that were not selected: ${unselected
        .map(([root, why]) => `${code(root)} (${why.slice(0, 2).join('; ')})`)
        .join(', ')}. Add them with \`--projects\` or change those paths.`,
    );
  }
  const folders = finding.folders;
  if (folders.length === 0) return;
  const maxFiles = ctx.maxFiles ?? DEFAULT_MAX_FILES;
  const lines: string[] = [];
  const kept: string[] = [];
  for (const f of folders) {
    let copy: CopyResult;
    try {
      copy = copyIntoTree(
        tree,
        path.join(ctx.sourceDir, ...f.path.split('/')),
        f.path,
        SHARED_SKIP,
        {
          ignoreFrom: ctx.sourceDir,
          maxFiles: maxFiles - data.copied,
          keepExisting: true,
        },
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(TOO_MANY)) {
        throw new Error(
          `migrate: the selected projects and the folders they use have more than ${maxFiles} ` +
            'files to copy after the skip lists. Narrow --projects, clean up the source, or raise ' +
            '--max-files.',
        );
      }
      throw err;
    }
    recordCopy(data, copy, f.path);
    kept.push(...(copy.existing ?? []).map((e) => `${f.path}/${e}`));
    const why = f.reasons.slice(0, 3).join('; ') + (f.reasons.length > 3 ? '; …' : '');
    lines.push(
      `${code(f.path)} (${copy.copied.length} file${copy.copied.length === 1 ? '' : 's'}; ${why})`,
    );
  }
  data.notes.push(
    `Copied folders the projects use that are not Nx projects, at the same paths: ${lines.join(
      ', ',
    )}.`,
  );
  if (kept.length > 0) {
    data.notes.push(
      `Files the workspace already had were kept, not overwritten: ${kept
        .slice(0, 10)
        .map(code)
        .join(', ')}${kept.length > 10 ? ` and ${kept.length - 10} more` : ''}. Compare them ` +
        'with the source.',
    );
  }
}

/** Root files that options or npm scripts use (not secrets, not already in the workspace). */
function copyRootFiles(
  tree: Tree,
  ctx: WorkspaceMigrationContext,
  files: RootFile[],
  data: WorkspaceReportData,
): void {
  const copied: string[] = [];
  const existing: string[] = [];
  for (const f of files) {
    if (isPossibleSecret(f.path)) {
      if (!data.secrets.includes(f.path)) data.secrets.push(f.path);
      continue;
    }
    if (tree.exists(f.path)) {
      existing.push(f.path);
      continue;
    }
    const abs = path.join(ctx.sourceDir, f.path);
    tree.write(f.path, fs.readFileSync(abs), { mode: fs.statSync(abs).mode & 0o777 });
    data.copied += 1;
    copied.push(`${code(f.path)} (${f.reasons.slice(0, 2).join('; ')})`);
  }
  if (copied.length > 0) {
    data.notes.push(`Copied root files the projects or npm scripts use: ${copied.join(', ')}.`);
  }
  if (existing.length > 0) {
    data.notes.push(
      `Root files the workspace already had were kept: ${existing.map(code).join(', ')}. ` +
        'Compare them with the source.',
    );
  }
}

/**
 * Replaces a copied project's flat ESLint config (eslint.config.js at the project root) with an
 * .eslintrc.json for the workspace; nested flat configs are removed. Returns the files replaced.
 */
function convertFlatEslint(tree: Tree, root: string, copied: string[]): string[] {
  const flat = copied.filter((f) => FLAT_ESLINT_FILE.test(f));
  if (flat.length === 0) return [];
  const own = flat.find((f) => !f.includes('/'));
  const rc = `${root}/.eslintrc.json`;
  if (own && !tree.exists(rc)) {
    writeJson(tree, rc, eslintrcForFlatConfig(tree.read(`${root}/${own}`, 'utf8') ?? '', root));
  }
  for (const f of flat) tree.delete(`${root}/${f}`);
  const pj = `${root}/project.json`;
  if (tree.exists(pj)) {
    updateJson(tree, pj, (json) => {
      for (const target of Object.values((json.targets ?? {}) as Record<string, Json>)) {
        const options = target['options'] as Json | undefined;
        const config = options?.['eslintConfig'];
        if (typeof config === 'string' && FLAT_ESLINT_FILE.test(config)) {
          delete (options as Json)['eslintConfig'];
        }
      }
      return json;
    });
  }
  return flat.map((f) => `${root}/${f}`);
}

const mainOf = (targets: Json): string | undefined => {
  const main = (objectField(targets, 'build')['options'] as Json | undefined)?.['main'];
  return typeof main === 'string' ? main : undefined;
};

/**
 * The release target of a migrated app: the env folder its fileReplacements use
 * (environments/<x>/…), and base hrefs from the source's build scripts.
 */
function shapeReleaseTarget(
  targets: Json,
  p: PlannedProject,
  scripts: BuildScriptInfo,
  notes: string[],
): void {
  const release = targets['release'];
  if (!isObject(release) || !isObject(release['options'])) return;
  const options = release['options'] as Json;
  const envProject = envFolderOf(objectField(targets, 'build'));
  if (envProject && envProject !== options['envProject']) options['envProject'] = envProject;
  const hrefs = scripts.baseHrefs.get(p.source.name);
  if (!hrefs) return;
  const configurations = isObject(release['configurations'])
    ? (release['configurations'] as Record<string, Json>)
    : {};
  const applied: string[] = [];
  for (const [name, config] of Object.entries(configurations)) {
    const href = hrefs[name] ?? hrefs['*'];
    if (!href || href === '/' || !isObject(config)) continue;
    config['baseHref'] = href;
    applied.push(`${name}: ${href}`);
  }
  if (applied.length > 0) {
    notes.push(`release target base hrefs from the source build scripts: ${applied.join(', ')}`);
  }
}

/** "environments/<x>/environment.prod.ts" in the build's fileReplacements → "<x>". */
function envFolderOf(build: Json): string | undefined {
  const sets = [build['options'], ...Object.values(objectField(build, 'configurations'))];
  for (const set of sets) {
    const replacements = isObject(set) ? set['fileReplacements'] : undefined;
    if (!Array.isArray(replacements)) continue;
    for (const r of replacements) {
      const w = isObject(r) ? r['with'] ?? r['replaceWith'] : undefined;
      const m = typeof w === 'string' ? /^(?:\.\/)?environments\/([^/]+)\/[^/]+$/.exec(w) : null;
      if (m) return m[1];
    }
  }
  return undefined;
}

/**
 * The source's root package.json fields the install and the build rely on: `overrides`,
 * `browser`, `engines` (missing keys only), and the npm scripts the workspace does not have.
 * Returns the scripts not carried over (name clashes).
 */
interface ScriptContext {
  /** Source project name → workspace name (differs with --prefix). */
  renames: Map<string, string>;
  /** Every source project name. */
  all: Set<string>;
}

const scriptContext = (plan: NxImportPlan): ScriptContext => ({
  renames: plan.renames,
  all: new Set(plan.all.map((p) => p.name)),
});

/** Project names a script command refers to, with where each one is (for renaming). */
const SCRIPT_PROJECT_REFS: RegExp[] = [
  // nx/ng <verb> <project> (not run, run-many, affected, graph, …)
  /\b(?:nx|ng)\s+(?!run\b|run-many\b|affected\b|graph\b|g\b|generate\b|migrate\b|reset\b|show\b)[\w:-]+\s+(?!-)([\w.-]+)/g,
  // nx run <project>:<target>
  /\bnx\s+run\s+([\w.-]+):/g,
  // --project=<p>, --projects=<a,b>, --app=<p>
  /--(?:projects?|app)[=\s]+(['"]?)([\w.,-]+)\1/g,
];

/**
 * The script with project names renamed, or why it is not carried (a project not imported).
 * `--project=`/`--app=` are renamed only in nx/ng commands: a custom script (`node build.js
 * --project=web`) looks the name up itself (base-href maps, env folders), so it keeps the source
 * name and is listed in `sourceNames`.
 */
export function rewriteScript(
  command: string,
  ctx: { renames: ReadonlyMap<string, string>; all: ReadonlySet<string> },
): { command: string; sourceNames: string[] } | { missing: string[] } {
  const missing = new Set<string>();
  const sourceNames = new Set<string>();
  const rename = (name: string) => {
    if (!ctx.all.has(name)) return name;
    const to = ctx.renames.get(name);
    if (to === undefined) missing.add(name);
    return to ?? name;
  };
  const segments = command.split(/(&&|\|\||;|\|)/);
  const out = segments
    .map((seg) => {
      if (/^(&&|\|\||;|\|)$/.test(seg)) return seg;
      let s = seg.replace(
        SCRIPT_PROJECT_REFS[0],
        (m, name: string) => m.slice(0, m.length - name.length) + rename(name),
      );
      s = s.replace(SCRIPT_PROJECT_REFS[1], (m, name: string) => m.replace(name, rename(name)));
      const nxCommand = /^\s*(?:npx\s+)?(?:nx|ng)\s/.test(s);
      s = s.replace(SCRIPT_PROJECT_REFS[2], (m, _q, list: string) => {
        const names = list.split(',');
        if (nxCommand) return m.replace(list, names.map(rename).join(','));
        for (const n of names) {
          const to = rename(n);
          if (to !== n) sourceNames.add(n);
        }
        return m;
      });
      return s;
    })
    .join('');
  return missing.size > 0
    ? { missing: [...missing].sort() }
    : { command: out, sourceNames: [...sourceNames].sort() };
}

function carryRootPackageFields(
  tree: Tree,
  sourcePkg: Record<string, unknown> | undefined,
  data: WorkspaceReportData,
  scriptCtx: ScriptContext,
): Record<string, string> {
  if (!sourcePkg) return {};
  const added: string[] = [];
  const clashes: string[] = [];
  const notCarried: Record<string, string> = {};
  const keptScripts: string[] = [];
  const renamedScripts: string[] = [];
  const lifecycle: string[] = [];
  const forMissing: string[] = [];
  const sourceNamed: string[] = [];
  const nodeMajor = workspaceNodeMajor(tree);
  let nodeKept: { range: string; unreadable: boolean } | undefined;
  updateJson(tree, 'package.json', (json) => {
    for (const field of ['overrides', 'engines', 'browser']) {
      const from = sourcePkg[field];
      if (from === undefined) continue;
      if (isObject(from)) {
        const into = isObject(json[field]) ? json[field] : {};
        for (const [k, v] of Object.entries(from)) {
          // A Node range the workspace's own Node (.nvmrc) is outside of would stop npm install
          // (engine-strict) or the workspace tooling, so it is reported instead.
          const allows =
            field === 'engines' && k === 'node' && nodeMajor !== undefined && into[k] === undefined
              ? nodeRangeAllowsMajor(String(v), nodeMajor)
              : true;
          if (allows !== true) {
            nodeKept = { range: String(v), unreadable: allows === undefined };
            continue;
          }
          if (into[k] === undefined) {
            into[k] = v;
            added.push(`${field}.${k}`);
          } else if (JSON.stringify(into[k]) !== JSON.stringify(v)) {
            clashes.push(`${field}.${k}`);
          }
        }
        json[field] = into;
      } else if (json[field] === undefined) {
        json[field] = from;
        added.push(field);
      } else if (JSON.stringify(json[field]) !== JSON.stringify(from)) {
        clashes.push(field);
      }
    }
    const scripts = isObject(json.scripts) ? json.scripts : {};
    for (const [k, v] of Object.entries(
      isObject(sourcePkg['scripts']) ? (sourcePkg['scripts'] as Record<string, string>) : {},
    )) {
      if (LIFECYCLE_SCRIPTS.has(k)) {
        if (scripts[k] !== v) lifecycle.push(k);
        continue;
      }
      const rewritten =
        typeof v === 'string' ? rewriteScript(v, scriptCtx) : { command: v, sourceNames: [] };
      if ('missing' in rewritten) {
        forMissing.push(`${code(k)} (${rewritten.missing.map(code).join(', ')})`);
        continue;
      }
      if (scripts[k] === undefined) {
        scripts[k] = rewritten.command;
        keptScripts.push(k);
        if (rewritten.command !== v) renamedScripts.push(k);
        for (const n of rewritten.sourceNames) {
          sourceNamed.push(`${code(k)} (\`${n}\` → \`${scriptCtx.renames.get(n)}\`)`);
        }
      } else if (scripts[k] !== rewritten.command) {
        notCarried[k] = v;
      }
    }
    json.scripts = scripts;
    return json;
  });
  const lockfile = ['pnpm-lock.yaml', 'yarn.lock'].find((f) => tree.exists(f));
  if (lockfile && added.some((a) => a.startsWith('overrides.'))) {
    data.notes.push(
      `The workspace uses ${lockfile === 'yarn.lock' ? 'Yarn' : 'pnpm'} (\`${lockfile}\`), which ` +
        `ignores npm \`overrides\`: move them to \`${
          lockfile === 'yarn.lock' ? 'resolutions' : 'pnpm.overrides'
        }\`.`,
    );
  }
  // Carried, so no longer listed under "Other package.json fields".
  data.packageFields = data.packageFields.filter((f) => f.field !== 'overrides');
  if (added.length > 0) {
    data.notes.push(
      `Carried from the source root \`package.json\`: ${added.map(code).join(', ')} (dependency ` +
        'overrides, browser field and engines the install and build rely on).',
    );
  }
  if (nodeKept !== undefined) {
    data.notes.push(
      nodeKept.unreadable
        ? `The source root \`package.json\` sets \`engines.node\` to ${code(
            nodeKept.range,
          )}, which could not be checked against the workspace's Node ${nodeMajor} ` +
            '(`.nvmrc`); it was not carried over (npm installs with `engine-strict`). Add it by ' +
            `hand if it allows Node ${nodeMajor}.`
        : `The source root \`package.json\` sets \`engines.node\` to ${code(
            nodeKept.range,
          )}; it was not carried over because the workspace runs Node ${nodeMajor} ` +
            '(`.nvmrc`), which its tooling needs. Check that the migrated apps build on that Node.',
    );
  }
  if (clashes.length > 0) {
    data.notes.push(
      `The source root \`package.json\` sets ${clashes.map(code).join(', ')} differently from ` +
        'the workspace; the workspace values were kept. Compare them.',
    );
  }
  if (lifecycle.length > 0) {
    data.notes.push(
      `npm lifecycle scripts of the source were not carried over (they run on every install): ` +
        `${lifecycle
          .sort()
          .map((k) => `${code(k)}: ${code(String((sourcePkg['scripts'] as Json)[k]))}`)
          .join(', ')}. Add what the workspace still needs by hand.`,
    );
  }
  if (forMissing.length > 0) {
    data.notes.push(
      `npm scripts for projects that were not imported were not carried over: ${forMissing.join(
        ', ',
      )}.`,
    );
  }
  if (sourceNamed.length > 0) {
    data.notes.push(
      `These kept npm scripts pass the source project name to a custom script, which looks it ` +
        `up itself (base hrefs, env folders): ${sourceNamed.join(', ')}. The Nx project has the ` +
        'new name: update the `nx build`/`nx run` calls inside the script.',
    );
  }
  if (renamedScripts.length > 0) {
    data.notes.push(
      `Project names were renamed (\`--prefix\`) in the kept npm scripts ${renamedScripts
        .sort()
        .map(code)
        .join(', ')}. Scripts they run (e.g. a custom build script) may still use the old names ` +
        'inside; update them by hand.',
    );
  }
  if (keptScripts.length > 0) {
    data.notes.push(
      `Source npm scripts kept in the workspace \`package.json\`: ${keptScripts
        .sort()
        .slice(0, 12)
        .map(code)
        .join(', ')}${keptScripts.length > 12 ? ` and ${keptScripts.length - 12} more` : ''}.`,
    );
  }
  return notCarried;
}

function noteBuildScripts(
  info: BuildScriptInfo,
  data: WorkspaceReportData,
  envEncryptionApplied = false,
): void {
  const names = Object.keys(info.customBuilds).sort();
  if (names.length === 0) return;
  data.notes.push(
    `The source builds its apps through ${info.customScripts.map(code).join(', ')} ` +
      `(npm scripts ${names.slice(0, 6).map(code).join(', ')}${
        names.length > 6 ? ` and ${names.length - 6} more` : ''
      }). Those scripts ` +
      'were kept and stay the way to build these apps for now: the polystack `release` target ' +
      'was added alongside (`npx nx run <app>:release:<env>`), but it does not run their extra ' +
      (envEncryptionApplied
        ? 'steps (obfuscation, comment stripping, …); env encryption is set up to match theirs, ' +
          'and the stamp fields when they set them (see the env encryption note). '
        : 'steps (env encryption as they do it, stamping, obfuscation, …). ') +
      'Npm scripts of the same name keep the source command.',
  );
  if (info.unread.length > 0) {
    data.notes.push(
      `Base hrefs for ${info.unread.map(code).join(', ')} could not be read from the build ` +
        "scripts; set `baseHref` on their release target's configurations.",
    );
  }
}

/** Non-relative imports through `baseUrl: "."` (e.g. `environments/x/y`) need it in the workspace. */
function baseUrlForImports(tree: Tree, sourceDir: string, data: WorkspaceReportData): void {
  const sourceCo = objectField(
    readSourceJson<Json>(sourceDir, 'tsconfig.base.json'),
    'compilerOptions',
  );
  const baseUrl = sourceCo['baseUrl'];
  if (typeof baseUrl !== 'string' || !tree.exists('tsconfig.base.json')) return;
  const ws = readJson(tree, 'tsconfig.base.json');
  const wsBase = ws?.compilerOptions?.baseUrl;
  if (wsBase === undefined) {
    updateJson(tree, 'tsconfig.base.json', (json) => {
      json.compilerOptions = { ...(json.compilerOptions ?? {}), baseUrl };
      return json;
    });
    data.notes.push(
      `Set \`baseUrl: "${baseUrl}"\` in \`tsconfig.base.json\` as the source had it; imports ` +
        'such as `environments/<app>/…` resolve through it.',
    );
  } else if (path.posix.normalize(wsBase) !== path.posix.normalize(baseUrl)) {
    data.notes.push(
      `The source \`tsconfig.base.json\` has \`baseUrl: "${baseUrl}"\`, the workspace ` +
        `\`"${wsBase}"\`. Imports that go through the source baseUrl may not resolve.`,
    );
  }
}

/** Plugin names in an nx.json `plugins` list (strings or `{ plugin }` objects). */
export function inferencePlugins(nxJson: Json | undefined): string[] {
  const list = nxJson?.['plugins'];
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => (typeof p === 'string' ? p : (p as Json | null)?.['plugin']))
    .filter((p): p is string => typeof p === 'string');
}
