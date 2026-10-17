import * as path from 'path';

import { GeneratorCallback, installPackagesTask, Tree, updateJson } from '@nx/devkit';

import { ngPackagrDependencies } from '../../../lib/utils/angular-deps';
import { noncePatchMains } from '../../../lib/utils/csp-nonce';
import { addMissingDependencies, declaredVersion } from '../../../lib/utils/dependencies';
import { addNpmScripts } from '../../../lib/utils/npm-scripts';
import { setProjectTags } from '../../../lib/utils/nx-targets';
import { angularCodeNotes } from '../angular-code-scan';
import { angularAppNpmScripts, angularProjectJson, PathMapper } from '../angular-project-json';
import { aliasesToSource, rerootAliases } from '../angular-workspace/aliases';
import { rewriteNgPackage } from '../angular-workspace/ng-package';
import { withAngularLintExtends } from '../angular-workspace/eslint';
import { discoverAngularProjects, LibraryInfo, libraryInfo } from '../angular-workspace/source';
import { copyIntoTree, DEFAULT_MAX_FILES, SkipRules } from '../copy';
import {
  angularMismatch,
  angularMismatchMessage,
  mergeDependencies,
  packageNames,
} from '../dependencies';
import { nativeClassifier } from '../ionic/packages';
import { applyIonicShape, nativeImports } from '../ionic/shape';
import { withIonicSkip } from '../ionic/skip';
import { kebabName } from '../names';
import { readSourceAliases, selectProjects } from '../nx/selection';
import { isObject, isSupportedKind, Json, SourceProject } from '../nx/workspace-source';
import { catalogMissMessage, sourceRootPackage } from '../pnpm';
import { parseJsonStrict, readSourceJson, readSourcePackageJson, sourceExists } from '../source';

import {
  ANGULAR_SKIP,
  ANGULAR_SKIP_NESTED,
  AngularProject,
  baseUrlImports,
  migrateEslint,
  migrateProjectTsconfigs,
} from './angular-cli';
import {
  classifyWorkspaceSpec,
  dependencyFields,
  treeProjectNames,
  workspacePaths,
} from './nx-workspace';
import {
  Detection,
  emptyReportData,
  MigrationContext,
  recordCopy,
  WorkspaceMigrationAdapter,
  WorkspaceMigrationContext,
  WorkspaceReportData,
} from './types';

interface Planned {
  source: SourceProject;
  /** Name in the workspace. */
  name: string;
  /** apps/<name> or libs/<name>. */
  newRoot: string;
  /** Source names of the projects that need it; [] when selected. */
  neededBy: string[];
}

interface AngularWorkspacePlan {
  all: SourceProject[];
  projects: Planned[];
  libs: Map<string, LibraryInfo>;
  aliases: { mapped: Record<string, string[]>; unmapped: string[] };
  newProjectRoot: string;
}

const code = (s: string) => `\`${s}\``;
const writeJson = (tree: Tree, file: string, value: unknown) =>
  tree.write(file, JSON.stringify(value, null, 2) + '\n');

export function detectAngularWorkspace(sourceDir: string): Detection {
  if (sourceExists(sourceDir, 'nx.json')) {
    return { confidence: 0, reasons: ['nx.json: an Nx workspace'] };
  }
  if (!sourceExists(sourceDir, 'angular.json')) {
    return { confidence: 0, reasons: ['no angular.json'] };
  }
  const projects = discoverAngularProjects(sourceDir);
  if (projects.length === 0) return { confidence: 0, reasons: ['angular.json has no projects'] };
  // e2e-only projects do not count: an app plus its e2e project is a single-app repo.
  if (projects.filter((p) => p.kind !== 'e2e').length <= 1) {
    return {
      confidence: 0,
      reasons: ['angular.json has one project: the angular-cli or ionic adapter handles it'],
    };
  }
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const summary = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${n} ${k}`);
  const reasons = [`angular.json with ${projects.length} projects: ${summary.join(', ')}`];
  return projects.some((p) => isSupportedKind(p.kind))
    ? { confidence: 0.95, reasons }
    : { confidence: 0.3, reasons: [...reasons, 'no project nx-polystack can migrate yet'] };
}

/** The angular.json project as written (architect/builder), for angularProjectJson. */
function rawProject(sourceDir: string, name: string): AngularProject {
  const ws = readSourceJson<Json>(sourceDir, 'angular.json');
  const projects = isObject(ws?.['projects']) ? (ws?.['projects'] as Json) : {};
  return (projects[name] ?? {}) as AngularProject;
}

/** Selection, names, aliases and every check; throws (writing nothing) when something is in the way. */
export function planAngularWorkspace(
  tree: Tree,
  ctx: WorkspaceMigrationContext,
): AngularWorkspacePlan {
  const { sourceDir } = ctx;
  const all = discoverAngularProjects(sourceDir);
  const libs = new Map(
    all.filter((p) => p.kind === 'lib').map((p) => [p.name, libraryInfo(sourceDir, p)]),
  );
  const sourceAliases = aliasesToSource(
    readSourceAliases(sourceDir),
    all
      .filter((p) => libs.has(p.name))
      .map((p) => ({ root: p.root, ...(libs.get(p.name) as LibraryInfo) })),
  );
  const chosen = selectProjects({
    sourceDir,
    projects: all,
    requested: ctx.projects,
    noDeps: ctx.noDeps,
    aliases: sourceAliases,
  });
  const byName = new Map(all.map((p) => [p.name, p]));
  const projects: Planned[] = [...chosen]
    .map(([n, neededBy]) => {
      const source = byName.get(n) as SourceProject;
      const name = kebabName(ctx.prefix ? `${ctx.prefix}-${n}` : n);
      const folder = source.kind === 'lib' ? 'libs' : 'apps';
      return { source, name, newRoot: `${folder}/${name}`, neededBy };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  const ws = readSourceJson<Json>(sourceDir, 'angular.json');
  const newProjectRoot =
    typeof ws?.['newProjectRoot'] === 'string'
      ? path.posix.normalize(ws['newProjectRoot'] as string)
      : 'projects';
  // A root app owns alias targets only outside these (folders it is copied without).
  const excluded = [
    newProjectRoot,
    ...ANGULAR_SKIP.topLevel.filter((n) => !n.includes('.') || n.startsWith('.')),
    ...all.filter((p) => p.root && !chosen.has(p.name)).map((p) => p.root),
  ];
  const aliases = rerootAliases(
    sourceAliases,
    projects.map((p) => ({ root: p.source.root, newRoot: p.newRoot })),
    excluded,
  );

  const errors: string[] = [];
  const existing = new Set(treeProjectNames(tree));
  const names = new Set<string>();
  for (const p of projects) {
    if (names.has(p.name)) {
      errors.push(
        `two source projects become "${p.name}"; rename one with --prefix or in angular.json.`,
      );
    }
    names.add(p.name);
    if (tree.exists(p.newRoot)) {
      errors.push(
        `${code(p.newRoot)} already exists in the workspace (source project ${p.source.name}).`,
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
  for (const [alias, targets] of Object.entries(aliases.mapped)) {
    const current = wsPaths[alias];
    if (current && JSON.stringify(current) !== JSON.stringify(targets)) {
      errors.push(
        `the path alias "${alias}" maps to ${current.join(', ')} in the workspace but to ` +
          `${targets.join(', ')} after the import; imports would resolve to the wrong code.`,
      );
    }
  }
  const rootPkg = sourceRootPackage(sourceDir);
  if (rootPkg.unresolved.length > 0) {
    errors.push(catalogMissMessage('the source root package.json', rootPkg.unresolved));
  }
  const mismatch = angularMismatch(tree, rootPkg.pkg);
  if (mismatch && !ctx.forceAngular) errors.push(angularMismatchMessage(mismatch));
  if (errors.length > 0) {
    throw new Error(
      [
        `migrate: cannot import from ${sourceDir}. Nothing was written.`,
        ...errors.map((e) => `- ${e}`),
      ].join('\n'),
    );
  }
  return { all, projects, libs, aliases, newProjectRoot };
}

/**
 * A library's ng-packagr build → @nx/angular:package with dependsOn ^build. Library aliases now
 * point at source; @nx/angular:package points the aliases of buildable dependencies back at their
 * build output (plain ng-packagr would pull their source in and fail on rootDir).
 */
function useNxPackageBuild(projectJson: Json, newRoot: string): void {
  const targets = isObject(projectJson['targets']) ? (projectJson['targets'] as Json) : {};
  const build = targets['build'];
  if (!isObject(build) || build['executor'] !== '@angular-devkit/build-angular:ng-packagr') return;
  build['executor'] = '@nx/angular:package';
  build['outputs'] = [`{workspaceRoot}/dist/${newRoot}`];
  build['dependsOn'] = ['^build'];
}

/**
 * @nx/angular:package writes the library tsconfig to tmp/ and rebases its paths; an implicit
 * `include` (every file next to the config) would then match nothing there (TS18003). A library
 * tsconfig without `include`/`files` that does not extend another library tsconfig gets the
 * `include` Nx generates for libraries.
 */
function explicitLibInclude(tree: Tree, newRoot: string, copied: string[]): void {
  for (const rel of copied.filter((f) => /^tsconfig\.lib[^/]*\.json$/.test(f))) {
    const file = `${newRoot}/${rel}`;
    const json = parseJsonStrict<Json>(tree.read(file, 'utf8') ?? '', file);
    const ext = typeof json['extends'] === 'string' ? (json['extends'] as string) : '';
    if (json['include'] !== undefined || json['files'] !== undefined) continue;
    if (/tsconfig\.lib[^/]*\.json$/.test(ext)) continue;
    writeJson(tree, file, { ...json, include: ['**/*.ts'] });
  }
}

const TOO_MANY = 'migrate: the source has more than';

function copyProject(
  tree: Tree,
  ctx: WorkspaceMigrationContext,
  plan: AngularWorkspacePlan,
  p: Planned,
  alreadyCopied: number,
) {
  const { root, kind } = p.source;
  const otherRoots = plan.all.map((o) => o.root).filter((r) => r && r !== root);
  // A sub-folder project skips projects nested in it; a root project skips every other project
  // and the folder new projects go in.
  const nested = root
    ? otherRoots.filter((r) => r.startsWith(`${root}/`)).map((r) => r.slice(root.length + 1))
    : [...new Set([plan.newProjectRoot, ...otherRoots])];
  const base: SkipRules = root ? ANGULAR_SKIP_NESTED : ANGULAR_SKIP;
  const rules = kind === 'ionic-app' ? withIonicSkip(base) : base;
  const maxFiles = ctx.maxFiles ?? DEFAULT_MAX_FILES;
  try {
    return copyIntoTree(
      tree,
      root ? path.join(ctx.sourceDir, ...root.split('/')) : ctx.sourceDir,
      p.newRoot,
      { ...rules, paths: [...(rules.paths ?? []), ...nested] },
      { ignoreFrom: ctx.sourceDir, maxFiles: maxFiles - alreadyCopied },
    );
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

function migrateAngularWorkspace(tree: Tree, ctx: WorkspaceMigrationContext): WorkspaceReportData {
  const plan = planAngularWorkspace(tree, ctx);
  const { sourceDir } = ctx;
  const data: WorkspaceReportData = {
    ...emptyReportData(),
    projects: [],
    unsupported: [],
    layout: 'apps-libs',
  };
  if (!tree.exists('package.json')) writeJson(tree, 'package.json', {});
  const depsBefore = dependencyFields(tree);
  const namesBefore = packageNames(tree);
  const ionicApps: { p: Planned; releases: string[] }[] = [];
  let usesNgPackagr = false;
  const exists = (rel: string) => sourceExists(sourceDir, rel);
  const nameOf = (sourceName: string) =>
    plan.projects.find((x) => x.source.name === sourceName)?.name ?? sourceName;
  const renames = new Map(plan.projects.map((x) => [x.source.name, x.name]));
  const sourceTs = readSourceJson<Json>(sourceDir, 'tsconfig.json');
  const sourceCo = isObject(sourceTs?.['compilerOptions'])
    ? (sourceTs?.['compilerOptions'] as Json)
    : {};
  const baseUrlUsers: string[] = [];

  for (const p of plan.projects) {
    const { root, kind } = p.source;
    const copy = copyProject(tree, ctx, plan, p, data.copied);
    recordCopy(data, copy, root);

    const pj = angularProjectJson({
      sourceProject: p.source.name,
      project: rawProject(sourceDir, p.source.name),
      name: p.name,
      projectRoot: p.newRoot,
      exists,
      renames,
    });
    if (kind === 'lib') useNxPackageBuild(pj.projectJson, p.newRoot);
    writeJson(tree, `${p.newRoot}/project.json`, pj.projectJson);
    data.notes.push(...pj.warnings.map((w) => `${code(p.name)} project.json: ${w}`));
    data.angularNotes.push(...pj.angularNotes.map((n) => `${code(p.name)} ${n}`));
    data.angularNotes.push(...angularCodeNotes(tree, p.newRoot, copy.copied, code(p.name)));
    if (kind !== 'lib') {
      const main = (
        pj.projectJson['targets'] as Record<string, { options?: { main?: unknown } }>
      )?.['build']?.options?.main;
      const note = typeof main === 'string' ? noncePatchMains(tree, [main]) : undefined;
      if (note) data.notes.push(`${code(p.name)}: ${note}`);
    }

    const mapper: PathMapper = {
      sourceRoot: root,
      projectRoot: p.newRoot,
      name: p.name,
      exists,
      warnings: [],
    };
    const pctx: MigrationContext = {
      sourceDir,
      name: p.name,
      projectRoot: p.newRoot,
      forceAngular: ctx.forceAngular,
      maxFiles: ctx.maxFiles,
      rewriteImports: ctx.rewriteImports,
    };
    migrateProjectTsconfigs(tree, pctx, root, copy.copied, mapper, data);
    const prefix =
      typeof p.source.config['prefix'] === 'string' ? p.source.config['prefix'] : 'app';
    migrateEslint(tree, pctx, prefix as string, copy.copied, mapper, data);
    const eslintrc = `${p.newRoot}/.eslintrc.json`;
    if (copy.copied.includes('.eslintrc.json') && tree.exists(eslintrc)) {
      const config = parseJsonStrict<Json>(tree.read(eslintrc, 'utf8') ?? '', eslintrc);
      writeJson(tree, eslintrc, withAngularLintExtends(config));
    }
    if (typeof sourceCo['baseUrl'] === 'string') {
      baseUrlUsers.push(
        ...baseUrlImports(tree, p.newRoot, copy.copied, [plan.newProjectRoot]).map(
          (f) => `${p.newRoot}/${f}`,
        ),
      );
    }

    if (kind === 'lib') {
      setProjectTags(tree, p.newRoot, ['scope:shared', 'type:lib']);
      explicitLibInclude(tree, p.newRoot, copy.copied);
      const info = plan.libs.get(p.source.name);
      if (info?.ngPackage) {
        usesNgPackagr = true;
        const rel = root ? path.posix.relative(root, info.ngPackage) : info.ngPackage;
        const file = `${p.newRoot}/${rel}`;
        if (tree.exists(file)) {
          const json = parseJsonStrict<Json>(tree.read(file, 'utf8') ?? '', info.ngPackage);
          writeJson(tree, file, rewriteNgPackage(json, file, `dist/${p.newRoot}`));
        }
      }
      data.nextSteps.push(`\`npx nx build ${p.name}\``);
    } else {
      setProjectTags(tree, p.newRoot, ['scope:app', 'type:app', 'platform:web']);
      const targets = pj.projectJson['targets'] as Record<string, unknown>;
      addNpmScripts(
        tree,
        angularAppNpmScripts(p.name, targets['serve'] !== undefined, pj.releaseConfigurations),
        { force: false },
      );
      data.nextSteps.push(`\`npx nx build ${p.name}\``);
      if (kind === 'ionic-app') ionicApps.push({ p, releases: pj.releaseConfigurations });
    }
    data.projects.push({
      name: p.name,
      sourceName: p.source.name,
      kind,
      root: p.newRoot,
      why: p.neededBy.length === 0 ? 'selected' : `needed by ${p.neededBy.map(nameOf).join(', ')}`,
    });
  }
  if (baseUrlUsers.length > 0 && !ctx.rewriteImports) {
    data.notes.push(
      `The source tsconfig set \`baseUrl: "${String(sourceCo['baseUrl'])}"\`, which the ` +
        'migrated projects no longer have (the workspace base owns it). These files import ' +
        'through it and need relative imports or a path alias: ' +
        `${baseUrlUsers.map(code).join(', ')}.`,
    );
  }
  data.unsupported = plan.all
    .filter((p) => !isSupportedKind(p.kind))
    .map((p) => ({ name: p.name, kind: p.kind, root: p.root || '.' }));

  // tsconfig.base.json: aliases, pointed at the new folders.
  const aliasNames = Object.keys(plan.aliases.mapped);
  if (aliasNames.length > 0) {
    if (!tree.exists('tsconfig.base.json'))
      writeJson(tree, 'tsconfig.base.json', { compilerOptions: {} });
    updateJson(tree, 'tsconfig.base.json', (json) => {
      const co = json.compilerOptions ?? {};
      const paths = { ...(co.paths ?? {}) };
      for (const alias of aliasNames) {
        if (paths[alias] !== undefined) continue;
        paths[alias] = plan.aliases.mapped[alias];
        data.tsPathsAdded.push(alias);
      }
      json.compilerOptions = { ...co, paths };
      return json;
    });
  }
  if (plan.aliases.unmapped.length > 0) {
    data.notes.push(
      'Path aliases not added (they point outside the copied projects): ' +
        `${plan.aliases.unmapped.map(code).join(', ')}.`,
    );
  }

  // package.json
  const sourcePkg = sourceRootPackage(sourceDir).pkg;
  const roots = plan.projects.map((p) => p.source.root).filter(Boolean);
  const isNative = nativeClassifier(sourceDir);
  const imported = new Set(
    plan.projects.flatMap((p) => [...nativeImports(tree, p.newRoot, isNative)]),
  );
  mergeDependencies(
    tree,
    {
      sourceDir,
      sourcePkg,
      classify: (spec) => classifyWorkspaceSpec(spec, sourceDir, roots),
      copiedLabel: 'copied projects',
      angular: true,
      skip:
        ionicApps.length > 0
          ? {
              test: (n) => isNative(n) && !imported.has(n),
              reason:
                "native packages no copied code imports (they are in the Ionic apps' own " +
                'package.json)',
            }
          : undefined,
    },
    data,
  );
  data.sourceScripts = { ...(sourcePkg?.scripts ?? {}) };
  if (usesNgPackagr) {
    addMissingDependencies(tree, {}, ngPackagrDependencies(declaredVersion(tree, '@angular/core')));
  }

  const installApps: GeneratorCallback[] = [];
  if (ionicApps.length > 0) data.ionic = [];
  for (const { p, releases } of ionicApps) {
    const r = applyIonicShape(tree, {
      name: p.name,
      appRoot: p.newRoot,
      sourcePkg,
      isNative,
      alsoAtRoot: imported,
      releaseConfigurations: releases,
    });
    data.ionic?.push(r.report);
    if (r.installApp) installApps.push(r.installApp);
    data.nextSteps.push(`\`npx nx run ${p.name}:cap-sync --platform=android\``);
  }

  data.nextSteps.push(
    '`pstack env --name=<env>` adds an environment to every app; migrated apps keep their own ' +
      'environment files and fileReplacements',
  );
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

export const angularWorkspaceAdapter: WorkspaceMigrationAdapter = {
  kind: 'workspace',
  id: 'angular-workspace',
  label: 'multi-project Angular CLI workspace',
  detect: detectAngularWorkspace,
  defaultName: (sourceDir) => readSourcePackageJson(sourceDir)?.name,
  preflight: (tree, ctx) => {
    planAngularWorkspace(tree, ctx);
  },
  migrate: migrateAngularWorkspace,
};
