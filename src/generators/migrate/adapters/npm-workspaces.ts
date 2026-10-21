import * as path from 'path';

import { GeneratorCallback, Tree, updateJson } from '@nx/devkit';

import { ensureLintDependencies } from '../../../lib/utils/dependencies';
import { setProjectTags } from '../../../lib/utils/nx-targets';
import { extendRootEslintConfig } from '../angular-config-files';
import { PathMapper } from '../angular-project-json';
import { copyIntoTree, CopyResult, DEFAULT_MAX_FILES, SkipRules } from '../copy';
import {
  angularMismatch,
  angularMismatchMessage,
  buildAngularMajor,
  DependencySkip,
  mergeDependencies,
  packageNames,
} from '../dependencies';
import { kebabName, upTo } from '../names';
import { classifyDependencySpec, localPath, SpecKind } from '../npm-deps';
import {
  discoverPackages,
  NpmPackage,
  packageManager,
  readPnpmWorkspace,
  sourceRootPackage,
  sourceWorkspaceGlobs,
  WorkspacePackageJson,
  workspaceGlobs,
} from '../npm-workspaces/source';
import { importSpecifiers, selectProjects } from '../nx/selection';
import { isSupportedKind, listProjectFiles } from '../nx/workspace-source';
import { catalogMissMessage } from '../pnpm';
import {
  PackageJson,
  parseJsonStrict,
  readSourceJson,
  readSourceText,
  sourceExists,
} from '../source';

import { migrateAngularApp, migrateProjectTsconfigs } from './angular-cli';
import { migrateIonic } from './ionic';
import { treeProjectNames, workspacePaths } from './nx-workspace';
import {
  Detection,
  emptyReportData,
  MigrationContext,
  MigrationReportData,
  recordCopy,
  WorkspaceMigrationAdapter,
  WorkspaceMigrationContext,
  WorkspaceReportData,
} from './types';

interface Planned {
  source: NpmPackage;
  /** Name in the workspace. */
  name: string;
  /** apps/<name> or libs/<name>. */
  newRoot: string;
  /** Project names (source) of the packages that need it; [] when selected. */
  neededBy: string[];
}

export interface NpmWorkspacesPlan {
  all: NpmPackage[];
  projects: Planned[];
  /** Package name → the imported library's entry in the workspace. */
  aliases: Record<string, string[]>;
}

const code = (s: string) => `\`${s}\``;
const writeJson = (tree: Tree, file: string, value: unknown) =>
  tree.write(file, JSON.stringify(value, null, 2) + '\n');
const abs = (sourceDir: string, root: string) => path.join(sourceDir, ...root.split('/'));

export function detectNpmWorkspaces(sourceDir: string): Detection {
  const pnpmFile = sourceExists(sourceDir, 'pnpm-workspace.yaml');
  const listed =
    pnpmFile ||
    workspaceGlobs(readSourceJson<WorkspacePackageJson>(sourceDir, 'package.json')) !== undefined;
  if (!listed) return { confidence: 0, reasons: ['no "workspaces" in package.json'] };
  if (sourceExists(sourceDir, 'nx.json')) {
    return { confidence: 0, reasons: ['nx.json: the nx-workspace adapter handles it'] };
  }
  if (sourceExists(sourceDir, 'angular.json')) {
    return { confidence: 0, reasons: ['angular.json at the root: an Angular adapter handles it'] };
  }
  if (pnpmFile) {
    try {
      readPnpmWorkspace(sourceDir);
    } catch (err) {
      const why = (err as Error).message.replace(/^migrate: /, '').replace(/\. Simplify.*$/, '');
      return { confidence: 0.3, reasons: [why] };
    }
  }
  const globs = sourceWorkspaceGlobs(sourceDir);
  if (!globs) {
    return { confidence: 0.3, reasons: ['pnpm-workspace.yaml lists no `packages`'] };
  }
  const manager = packageManager(sourceDir);
  const packages = discoverPackages(sourceDir);
  if (packages.length === 0) {
    return {
      confidence: 0.3,
      reasons: [`${manager} workspaces, but no package folder matches ${globs.join(', ')}`],
    };
  }
  const counts = new Map<string, number>();
  for (const p of packages) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const summary = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${n} ${k}`);
  const reasons = [
    `${manager} workspaces with ${packages.length} package${packages.length > 1 ? 's' : ''}: ` +
      summary.join(', '),
  ];
  return packages.some((p) => isSupportedKind(p.kind))
    ? { confidence: 0.95, reasons }
    : { confidence: 0.3, reasons: [...reasons, 'no package nx-polystack can migrate yet'] };
}

/** Selection, names, aliases and every check; throws (writing nothing) when something is in the way. */
export function planNpmWorkspaces(tree: Tree, ctx: WorkspaceMigrationContext): NpmWorkspacesPlan {
  const { sourceDir } = ctx;
  // Throws (naming the file) when pnpm-workspace.yaml cannot be read.
  readPnpmWorkspace(sourceDir);
  const all = discoverPackages(sourceDir);
  const byPackageName = new Map(all.map((p) => [p.packageName, p.name]));
  // Imports of a package name (or a path under it) belong to that package.
  const sourceAliases: Record<string, string[]> = {};
  for (const p of all) {
    sourceAliases[p.packageName] = [p.entry ? `${p.root}/${p.entry}` : p.root];
    sourceAliases[`${p.packageName}/*`] = [`${p.root}/*`];
  }
  const chosen = selectProjects({
    sourceDir,
    projects: all,
    requested: ctx.projects?.map((r) => byPackageName.get(r) ?? r),
    noDeps: ctx.noDeps,
    aliases: sourceAliases,
  });
  const byName = new Map(all.map((p) => [p.name, p]));
  const projects: Planned[] = [...chosen]
    .map(([n, neededBy]) => {
      const source = byName.get(n) as NpmPackage;
      const name = kebabName(ctx.prefix ? `${ctx.prefix}-${n}` : n);
      const folder = source.kind === 'lib' ? 'libs' : 'apps';
      return { source, name, newRoot: `${folder}/${name}`, neededBy };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const aliases: Record<string, string[]> = {};
  for (const p of projects) {
    if (p.source.kind === 'lib' && p.source.entry) {
      aliases[p.source.packageName] = [`${p.newRoot}/${p.source.entry}`];
    }
  }

  const errors: string[] = [];
  const existing = new Set(treeProjectNames(tree));
  const names = new Set<string>();
  for (const p of projects) {
    if (names.has(p.name)) {
      errors.push(`two source packages become "${p.name}"; rename one with --prefix.`);
    }
    names.add(p.name);
    if (tree.exists(p.newRoot)) {
      errors.push(
        `${code(p.newRoot)} already exists in the workspace (source package ${
          p.source.packageName
        }).`,
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
  for (const [alias, targets] of Object.entries(aliases)) {
    const current = wsPaths[alias];
    if (current && JSON.stringify(current) !== JSON.stringify(targets)) {
      errors.push(
        `the path alias "${alias}" maps to ${current.join(', ')} in the workspace but to ` +
          `${targets.join(', ')} after the import; imports would resolve to the wrong code.`,
      );
    }
  }
  const root = sourceRootPackage(sourceDir);
  const catalogMisses: [string, string[]][] = [
    ['the source root package.json', root.unresolved],
    ...projects.map((p): [string, string[]] => [p.source.packageName, p.source.unresolvedCatalogs]),
  ];
  for (const [owner, misses] of catalogMisses) {
    if (misses.length > 0) errors.push(catalogMissMessage(owner, misses));
  }
  if (!ctx.forceAngular) {
    const pkgs: [string, PackageJson | undefined][] = [
      ['the source root', root.pkg],
      ...projects
        .filter((p) => p.source.kind !== 'lib')
        .map((p): [string, PackageJson] => [p.source.packageName, p.source.pkg]),
    ];
    for (const [, pkg] of pkgs) {
      const mismatch = angularMismatch(tree, pkg);
      if (mismatch) {
        errors.push(angularMismatchMessage(mismatch));
        break;
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(
      [
        `migrate: cannot import from ${sourceDir}. Nothing was written.`,
        ...errors.map((e) => `- ${e}`),
      ].join('\n'),
    );
  }
  return { all, projects, aliases };
}

/** Not copied from a library package (its package.json is merged into the root one). */
const LIB_SKIP: SkipRules = {
  anyDepth: ['node_modules', '.git'],
  topLevel: [
    'dist',
    'coverage',
    'out-tsc',
    'tmp',
    '.turbo',
    'package.json',
    'tsconfig.json',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ],
};

const TOO_MANY = 'migrate: the source has more than';

/** Other package folders inside this one (relative to it): they are imported on their own. */
function nestedPackages(plan: NpmWorkspacesPlan, p: Planned): string[] {
  const root = p.source.root;
  return plan.all
    .map((o) => o.root)
    .filter((r) => r !== root && r.startsWith(`${root}/`))
    .map((r) => r.slice(root.length + 1));
}

/** Runs a copy; a --max-files overflow names the whole import's limit. */
function withFileLimit<T>(ctx: WorkspaceMigrationContext, copy: () => T): T {
  const maxFiles = ctx.maxFiles ?? DEFAULT_MAX_FILES;
  try {
    return copy();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(TOO_MANY)) {
      throw new Error(
        `migrate: the selected packages have more than ${maxFiles} files to copy after the skip ` +
          'lists. Narrow --projects, clean up the source, or raise --max-files.',
      );
    }
    throw err;
  }
}

function copyPackage(
  tree: Tree,
  ctx: WorkspaceMigrationContext,
  plan: NpmWorkspacesPlan,
  p: Planned,
  alreadyCopied: number,
): CopyResult {
  const maxFiles = ctx.maxFiles ?? DEFAULT_MAX_FILES;
  return withFileLimit(ctx, () =>
    copyIntoTree(
      tree,
      abs(ctx.sourceDir, p.source.root),
      p.newRoot,
      { ...LIB_SKIP, paths: nestedPackages(plan, p) },
      { maxFiles: maxFiles - alreadyCopied, ignoreFrom: ctx.sourceDir },
    ),
  );
}

/** A TypeScript library package → libs/<name>: tsconfig, ESLint config and project.json. */
function migrateLib(
  tree: Tree,
  ctx: WorkspaceMigrationContext,
  plan: NpmWorkspacesPlan,
  p: Planned,
  data: MigrationReportData,
): GeneratorCallback | undefined {
  const pkgDir = abs(ctx.sourceDir, p.source.root);
  const copy = copyPackage(tree, ctx, plan, p, data.copied);
  recordCopy(data, copy, p.source.root);
  const up = upTo(p.newRoot);
  const mapper: PathMapper = {
    sourceRoot: '',
    projectRoot: p.newRoot,
    name: p.name,
    exists: (rel) => sourceExists(pkgDir, rel),
    warnings: [],
  };
  const pctx: MigrationContext = {
    sourceDir: pkgDir,
    name: p.name,
    projectRoot: p.newRoot,
    forceAngular: ctx.forceAngular,
    rewriteImports: ctx.rewriteImports,
  };
  const angularMajor = buildAngularMajor(tree, sourceRootPackage(ctx.sourceDir).pkg);
  migrateProjectTsconfigs(tree, pctx, '', copy.copied, mapper, data, angularMajor);
  if (sourceExists(pkgDir, 'tsconfig.json')) {
    // Apps compile the library source through its alias; project references and composite
    // builds pointed at the old package layout.
    updateJson(tree, `${p.newRoot}/tsconfig.json`, (json) => {
      const dropped: string[] = [];
      if (json.references !== undefined) {
        delete json.references;
        dropped.push('`references`');
      }
      for (const o of ['composite', 'tsBuildInfoFile']) {
        if (json.compilerOptions?.[o] !== undefined) {
          delete json.compilerOptions[o];
          dropped.push(`\`${o}\``);
        }
      }
      if (dropped.length > 0) {
        data.notes.push(
          `${code(p.name)}: ${dropped.join(', ')} removed from tsconfig.json (apps build the ` +
            'library source through its path alias).',
        );
      }
      return json;
    });
  } else {
    // No tsconfig of its own: the `pstack lib --type=ts` pair.
    writeJson(tree, `${p.newRoot}/tsconfig.json`, {
      extends: `${up}tsconfig.base.json`,
      compilerOptions: { forceConsistentCasingInFileNames: true, strict: true },
      files: [],
      include: [],
      references: [{ path: './tsconfig.lib.json' }],
    });
    if (!tree.exists(`${p.newRoot}/tsconfig.lib.json`)) {
      writeJson(tree, `${p.newRoot}/tsconfig.lib.json`, {
        extends: './tsconfig.json',
        compilerOptions: { outDir: `${up}dist/out-tsc`, declaration: true, types: [] },
        include: ['**/*.ts'],
        exclude: ['**/*.spec.ts', '**/*.test.ts'],
      });
    }
  }
  const ownEslint = copy.copied.filter((f) =>
    /^(\.eslintrc(\.[a-z]+)?|eslint\.config\.[a-z]+)$/.test(f),
  );
  if (ownEslint.length === 0) {
    writeJson(tree, `${p.newRoot}/.eslintrc.json`, {
      extends: [`${up}.eslintrc.json`],
      ignorePatterns: ['!**/*'],
      overrides: [{ files: ['*.ts'], rules: {} }],
    });
  } else if (ownEslint.length === 1 && ownEslint[0] === '.eslintrc.json') {
    const file = `${p.newRoot}/.eslintrc.json`;
    const config = extendRootEslintConfig(
      parseJsonStrict<Record<string, unknown>>(tree.read(file, 'utf8') ?? '', file),
      mapper,
    );
    const outside = (config['extends'] as string[]).filter((e, i) => i > 0 && e.startsWith('../'));
    config['extends'] = (config['extends'] as string[]).filter((e) => !outside.includes(e));
    writeJson(tree, file, config);
    if (outside.length > 0) {
      data.notes.push(
        `${code(p.name)}: ESLint extends ${outside.map(code).join(', ')} pointed outside the ` +
          'package and were removed; the workspace root config is extended instead.',
      );
    }
  } else {
    data.notes.push(
      `${code(p.name)} kept its own ESLint config (${ownEslint.map(code).join(', ')}); make it ` +
        `extend ${code(`${up}.eslintrc.json`)} so \`nx lint\` uses the workspace rules.`,
    );
  }
  const sourceRoot = sourceExists(pkgDir, 'src') ? `${p.newRoot}/src` : p.newRoot;
  writeJson(tree, `${p.newRoot}/project.json`, {
    name: p.name,
    $schema: `${up}node_modules/nx/schemas/project-schema.json`,
    sourceRoot,
    projectType: 'library',
    tags: [],
    targets: {
      lint: {
        executor: '@nx/eslint:lint',
        outputs: ['{options.outputFile}'],
        options: { lintFilePatterns: [`${p.newRoot}/**/*.ts`] },
      },
    },
  });
  setProjectTags(tree, p.newRoot, ['scope:shared', 'type:lib']);
  return ensureLintDependencies(tree);
}

/** Adds one package's report data (paths relative to its folder) to the import's. */
function absorb(into: MigrationReportData, from: MigrationReportData, p: Planned): void {
  const at = (s: string) => `${p.source.root}/${s}`;
  into.copied += from.copied;
  into.skipped.push(...from.skipped.map(at));
  into.secrets.push(...from.secrets.map(at));
  into.gitListed = into.gitListed || from.gitListed;
  into.gitignoreUsed = into.gitignoreUsed || from.gitignoreUsed;
  into.dependencyClashes.push(
    ...from.dependencyClashes.filter((c) => !into.dependencyClashes.some((d) => d.name === c.name)),
  );
  into.tsPathsAdded.push(...from.tsPathsAdded.filter((a) => !into.tsPathsAdded.includes(a)));
  into.tsPathClashes.push(...from.tsPathClashes);
  into.packageFields.push(...from.packageFields);
  into.angularNotes.push(...from.angularNotes.filter((n) => !into.angularNotes.includes(n)));
  into.notes.push(...from.notes.map((n) => `${code(p.name)}: ${n}`));
  into.nextSteps.push(...from.nextSteps.filter((s) => !into.nextSteps.includes(s)));
  if (from.ionic) into.ionic = [...(into.ionic ?? []), ...from.ionic];
  if (from.moves) into.moves = [...(into.moves ?? []), ...from.moves];
}

/** Root merge specs: a local path inside an imported package follows it to its new folder. */
function classifyMovedSpec(spec: string, sourceDir: string, plan: NpmWorkspacesPlan): SpecKind {
  const kind = classifyDependencySpec(spec, { sourceDir, copiedDir: sourceDir, projectRoot: '' });
  if (kind.kind !== 'rebased') return kind;
  const rel = kind.spec.slice('file:'.length);
  const p = plan.projects.find((x) => rel === x.source.root || rel.startsWith(`${x.source.root}/`));
  return p
    ? { kind: 'rebased', spec: `file:${p.newRoot}${rel.slice(p.source.root.length)}` }
    : { kind: 'outside', target: path.join(sourceDir, rel) };
}

/** Root and library dependencies as one package.json for the root merge (root wins). */
function combinedDependencies(
  sourceDir: string,
  libs: Planned[],
  internal: Set<string>,
  data: MigrationReportData,
): PackageJson {
  const root = sourceRootPackage(sourceDir).pkg ?? {};
  const out: PackageJson = {
    dependencies: { ...(root.dependencies ?? {}) },
    devDependencies: { ...(root.devDependencies ?? {}) },
    optionalDependencies: { ...(root.optionalDependencies ?? {}) },
    overrides: root.overrides,
    resolutions: root.resolutions,
  };
  const declared = (n: string) =>
    out.dependencies?.[n] ?? out.devDependencies?.[n] ?? out.optionalDependencies?.[n];
  const differing: string[] = [];
  for (const p of libs) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      for (const [n, raw] of Object.entries(p.source.pkg[field] ?? {})) {
        if (internal.has(n) || typeof raw !== 'string') continue;
        // Local paths are relative to the library's package.json; the merge reads them from the
        // source root.
        const local = localPath(raw);
        const spec =
          local !== undefined && !local.startsWith('/') && !local.startsWith('~/')
            ? `file:${path.posix.normalize(path.posix.join(p.source.root, local))}`
            : raw;
        const current = declared(n);
        if (current === undefined) (out[field] as Record<string, string>)[n] = spec;
        else if (current !== spec)
          differing.push(`${code(n)} (${p.source.packageName}: ${code(spec)})`);
      }
    }
  }
  if (differing.length > 0) {
    data.notes.push(
      'Library packages declare other versions than the one carried over (the source root or ' +
        `the first package wins): ${differing.join(', ')}.`,
    );
  }
  return out;
}

function migrateNpmWorkspaces(tree: Tree, ctx: WorkspaceMigrationContext): WorkspaceReportData {
  const plan = planNpmWorkspaces(tree, ctx);
  const { sourceDir } = ctx;
  const data: WorkspaceReportData = {
    ...emptyReportData(),
    projects: [],
    unsupported: [],
    layout: 'apps-libs',
  };
  if (!tree.exists('package.json')) writeJson(tree, 'package.json', {});
  const namesBefore = packageNames(tree);
  const internal = new Set(plan.all.map((p) => p.packageName));
  const skipInternal: DependencySkip = {
    test: (n) => internal.has(n),
    reason:
      'packages of the source workspace; imported libraries are path aliases in tsconfig.base.json',
  };
  const libs = plan.projects.filter((p) => p.source.kind === 'lib');
  const tasks: GeneratorCallback[] = [];

  // Root and library dependencies first: the app merges then see what the workspace has.
  const rootData = emptyReportData();
  const rootTask = mergeDependencies(
    tree,
    {
      sourceDir,
      sourcePkg: combinedDependencies(sourceDir, libs, internal, data),
      classify: (spec) => classifyMovedSpec(spec, sourceDir, plan),
      copiedLabel: 'imported packages',
      // The app packages hold the Angular versions; their own merges fill in the build packages.
      angular: false,
      skip: skipInternal,
    },
    rootData,
  );
  if (rootTask) tasks.push(rootTask);
  data.dependencyClashes.push(...rootData.dependencyClashes);
  data.packageFields.push(...rootData.packageFields);
  data.angularNotes.push(...rootData.angularNotes);
  data.notes.push(...rootData.notes);

  // tsconfig.base.json: each library's package name → its entry, before the apps merge their
  // own tsconfig paths (a source alias like "../utils/src" then clashes instead of winning).
  const aliasNames = Object.keys(plan.aliases);
  if (aliasNames.length > 0) {
    if (!tree.exists('tsconfig.base.json'))
      writeJson(tree, 'tsconfig.base.json', { compilerOptions: {} });
    updateJson(tree, 'tsconfig.base.json', (json) => {
      const co = json.compilerOptions ?? {};
      const paths = { ...(co.paths ?? {}) };
      for (const alias of aliasNames) {
        if (paths[alias] !== undefined) continue;
        paths[alias] = plan.aliases[alias];
        if (!data.tsPathsAdded.includes(alias)) data.tsPathsAdded.push(alias);
      }
      json.compilerOptions = { ...co, paths };
      return json;
    });
  }

  const nameOf = (sourceName: string) =>
    plan.projects.find((x) => x.source.name === sourceName)?.name ?? sourceName;
  for (const p of plan.projects) {
    if (p.source.kind === 'lib') {
      const task = migrateLib(tree, ctx, plan, p, data);
      if (task) tasks.push(task);
    } else {
      const pctx: MigrationContext = {
        sourceDir: abs(sourceDir, p.source.root),
        name: p.name,
        projectRoot: p.newRoot,
        forceAngular: ctx.forceAngular,
        maxFiles: (ctx.maxFiles ?? DEFAULT_MAX_FILES) - data.copied,
        rewriteImports: ctx.rewriteImports,
      };
      const opts = {
        ignoreFrom: sourceDir,
        skipPaths: nestedPackages(plan, p),
        sourcePkg: p.source.pkg,
        notesLabel: code(p.name),
      };
      const appData = withFileLimit(ctx, () =>
        p.source.kind === 'ionic-app'
          ? migrateIonic(tree, pctx, { ...opts, extraSkip: [skipInternal] })
          : migrateAngularApp(tree, pctx, { ...opts, dependencySkip: skipInternal }).data,
      );
      // The package's own tsconfig alias for a library imported here is replaced, not a clash.
      appData.tsPathClashes = appData.tsPathClashes.filter((c) => !plan.aliases[c.alias]);
      absorb(data, appData, p);
      if (appData.installTask) tasks.push(appData.installTask);
    }
    for (const [k, v] of Object.entries(p.source.pkg.scripts ?? {})) {
      data.sourceScripts[`${p.source.packageName}: ${k}`] = v;
    }
    data.projects.push({
      name: p.name,
      sourceName: p.source.packageName,
      kind: p.source.kind,
      root: p.newRoot,
      why: p.neededBy.length === 0 ? 'selected' : `needed by ${p.neededBy.map(nameOf).join(', ')}`,
    });
    if (p.source.kind === 'lib') data.nextSteps.push(`\`npx nx lint ${p.name}\``);
  }
  for (const [k, v] of Object.entries(
    readSourceJson<PackageJson>(sourceDir, 'package.json')?.scripts ?? {},
  )) {
    data.sourceScripts[k] = v;
  }
  data.unsupported = plan.all
    .filter((p) => !isSupportedKind(p.kind))
    .map((p) => ({ name: p.packageName, kind: p.kind, root: p.root }));

  if (packageManager(sourceDir) === 'pnpm') pnpmSettings(tree, sourceDir, data, namesBefore);
  const subpaths = librarySubpathImports(sourceDir, plan);
  const subpathAliases = ctx.rewriteImports
    ? addSubpathAliases(tree, plan, subpaths, data)
    : { added: [], kept: [] };
  notes(ctx, plan, data, subpaths, subpathAliases);
  data.dependenciesAdded = [...packageNames(tree)].filter((n) => !namesBefore.has(n)).sort();
  data.installTask =
    tasks.length > 0
      ? async () => {
          for (const t of tasks) await t();
        }
      : undefined;
  return data;
}

/** Report notes about what an npm/Yarn workspaces import leaves behind. */
function notes(
  ctx: WorkspaceMigrationContext,
  plan: NpmWorkspacesPlan,
  data: WorkspaceReportData,
  subpaths: string[],
  subpathAliases: { added: string[]; kept: string[] },
): void {
  const { sourceDir } = ctx;
  const manager = packageManager(sourceDir);
  const managerFiles =
    manager === 'pnpm'
      ? 'pnpm files (`pnpm-workspace.yaml`, `.pnpmfile.cjs`)'
      : 'Yarn files (`.yarnrc.yml`, `.yarn/`, `.pnp.*`)';
  data.notes.unshift(
    `The source used ${manager} workspaces. Only the package folders were copied: lockfiles, ` +
      `${managerFiles} and other root files were not; the workspace installs with npm.`,
  );
  if (sourceExists(sourceDir, '.npmrc')) {
    data.notes.push(
      `The source root \`.npmrc\` was not copied. Carry its registry and auth settings over to the ` +
        "workspace's `.npmrc` by hand if the imported packages need them" +
        (manager === 'pnpm' ? '; its pnpm settings do not apply to npm.' : '.'),
    );
  }
  const baseFile = ['tsconfig.base.json', 'tsconfig.json'].find((f) => sourceExists(sourceDir, f));
  const base = baseFile ? readSourceJson<Record<string, unknown>>(sourceDir, baseFile) : undefined;
  const co = base?.['compilerOptions'];
  if (
    co &&
    typeof co === 'object' &&
    Object.keys(co).some((k) => k !== 'paths' && k !== 'baseUrl')
  ) {
    data.notes.push(
      `The source root ${code(baseFile as string)} compilerOptions were not carried over; the ` +
        'projects extend the workspace `tsconfig.base.json` now. Compare the two if the build ' +
        'or type checks behave differently.',
    );
  }
  const importedPackages = new Set(plan.projects.map((p) => p.source.packageName));
  for (const p of plan.projects) {
    const deps = p.source.workspaceDependencies.filter((d) => !importedPackages.has(d));
    if (deps.length > 0) {
      data.notes.push(
        `${code(p.name)} depends on workspace package${deps.length > 1 ? 's' : ''} ` +
          `${deps.map(code).join(', ')}, which ${deps.length > 1 ? 'were' : 'was'} not imported.`,
      );
    }
  }
  if (subpaths.length === 0) return;
  if (!ctx.rewriteImports) {
    data.notes.push(
      'These imports reach into a library package below its entry and have no path alias: ' +
        `${subpaths.map(code).join(', ')}. Export what they need from the entry, or ` +
        'add a `<package>/*` alias to tsconfig.base.json.',
    );
    return;
  }
  const { added, kept } = subpathAliases;
  data.notes.push(
    `These imports reach into a library package below its entry: ${subpaths
      .map(code)
      .join(', ')}. ` +
      (added.length > 0
        ? `They resolve through the added ${added.map(code).join(', ')} alias${
            added.length > 1 ? 'es' : ''
          } (the package folder); check them against the package's \`exports\`. `
        : '') +
      (kept.length > 0
        ? `The workspace already maps ${kept.map(code).join(', ')}; check where it points. `
        : '') +
      'Exporting what they need from the entry is the cleaner fix.',
  );
}

/** Imports of a library package below its entry (`@acme/utils/x`) in the imported packages. */
function librarySubpathImports(sourceDir: string, plan: NpmWorkspacesPlan): string[] {
  const libNames = plan.projects
    .filter((p) => p.source.kind === 'lib')
    .map((p) => p.source.packageName);
  const subpaths = new Set<string>();
  for (const p of plan.projects) {
    for (const file of listProjectFiles(sourceDir, p.source.root)) {
      if (!/\.(ts|tsx|mts|js|mjs)$/.test(file) || file.endsWith('.d.ts')) continue;
      const text = readSourceText(sourceDir, `${p.source.root}/${file}`) ?? '';
      for (const spec of importSpecifiers(text)) {
        if (libNames.some((n) => spec.startsWith(`${n}/`))) subpaths.add(spec);
      }
    }
  }
  return [...subpaths].sort();
}

/**
 * With import rewriting on: a `<package>/*` alias to the library folder for each library whose
 * subpaths are imported (package subpaths resolve inside the package folder).
 */
function addSubpathAliases(
  tree: Tree,
  plan: NpmWorkspacesPlan,
  subpaths: string[],
  data: MigrationReportData,
): { added: string[]; kept: string[] } {
  const used = plan.projects.filter(
    (p) =>
      p.source.kind === 'lib' && subpaths.some((sp) => sp.startsWith(`${p.source.packageName}/`)),
  );
  const added: string[] = [];
  const kept: string[] = [];
  if (used.length === 0) return { added, kept };
  if (!tree.exists('tsconfig.base.json'))
    writeJson(tree, 'tsconfig.base.json', { compilerOptions: {} });
  updateJson(tree, 'tsconfig.base.json', (json) => {
    const co = json.compilerOptions ?? {};
    const paths = { ...(co.paths ?? {}) };
    for (const p of used) {
      const alias = `${p.source.packageName}/*`;
      if (paths[alias] === undefined) {
        paths[alias] = [`${p.newRoot}/*`];
        added.push(alias);
        if (!data.tsPathsAdded.includes(alias)) data.tsPathsAdded.push(alias);
      } else kept.push(alias);
    }
    json.compilerOptions = { ...co, paths };
    return json;
  });
  return { added, kept };
}

/** An npm overrides key: a package name, without pnpm's "a>b" or "pkg@<range" selectors. */
const FLAT_OVERRIDE = /^(@[^/@>\s]+\/)?[^/@>\s]+$/;

/**
 * pnpm overrides → npm overrides (flat package → version entries only), and report notes for the
 * pnpm settings that are not carried over.
 */
function pnpmSettings(
  tree: Tree,
  sourceDir: string,
  data: MigrationReportData,
  namesBefore: Set<string>,
): void {
  const ws = readPnpmWorkspace(sourceDir);
  const rootPkg = readSourceJson<Record<string, unknown>>(sourceDir, 'package.json') ?? {};
  const pnpmField =
    rootPkg['pnpm'] && typeof rootPkg['pnpm'] === 'object'
      ? (rootPkg['pnpm'] as Record<string, unknown>)
      : {};
  const fieldOverrides =
    pnpmField['overrides'] && typeof pnpmField['overrides'] === 'object'
      ? (pnpmField['overrides'] as Record<string, unknown>)
      : {};
  // pnpm-workspace.yaml settings take precedence over the package.json "pnpm" field.
  const overrides: Record<string, unknown> = { ...fieldOverrides, ...(ws?.overrides ?? {}) };
  const catalogs = ws?.catalogs ?? {};
  const carried: Record<string, string> = {};
  const notCarried: string[] = [];
  for (const [key, raw] of Object.entries(overrides)) {
    let value = typeof raw === 'string' ? raw.trim() : undefined;
    const cat = value !== undefined ? /^catalog:(.*)$/.exec(value) : null;
    if (cat) value = catalogs[cat[1].trim() || 'default']?.[key];
    // Removals, protocols npm cannot install from an overrides entry or that point at source
    // paths, and pnpm-only key syntax are reported instead.
    const portable =
      value !== undefined &&
      value !== '-' &&
      !/^(catalog|workspace|link|file|portal):/.test(value) &&
      localPath(value) === undefined &&
      FLAT_OVERRIDE.test(key);
    if (portable) carried[key] = value as string;
    else
      notCarried.push(`${code(key)}: ${code(typeof raw === 'string' ? raw : JSON.stringify(raw))}`);
  }
  if (Object.keys(carried).length > 0) {
    const differing: string[] = [];
    const added: string[] = [];
    const direct: string[] = [];
    const workspaceOwn: string[] = [];
    updateJson(tree, 'package.json', (json) => {
      const current: Record<string, unknown> = { ...(json.overrides ?? {}) };
      for (const [k, v] of Object.entries(carried)) {
        if (current[k] !== undefined) {
          if (current[k] !== v) {
            const was =
              typeof current[k] === 'string' ? (current[k] as string) : JSON.stringify(current[k]);
            differing.push(`${code(k)} (workspace ${code(was)}, source ${code(v)})`);
          }
          continue;
        }
        // npm refuses an override that differs from a direct dependency's spec (EOVERRIDE); as in
        // pnpm, a dependency this import added takes the overridden version instead. The
        // workspace's own dependencies are left alone.
        const field = (['dependencies', 'devDependencies', 'optionalDependencies'] as const).find(
          (f) => json[f]?.[k] !== undefined,
        );
        if (field && json[field][k] !== v) {
          if (namesBefore.has(k)) {
            workspaceOwn.push(
              `${code(k)} (workspace ${code(json[field][k])}, override ${code(v)})`,
            );
            continue;
          }
          direct.push(`${code(k)} ${code(json[field][k])} → ${code(v)}`);
          json[field][k] = v;
        }
        // The override still applies to the copies other packages pull in.
        current[k] = v;
        added.push(k);
      }
      if (Object.keys(current).length > 0) json.overrides = current;
      return json;
    });
    if (added.length > 0) {
      data.notes.push(
        `pnpm overrides became npm \`overrides\` in package.json: ${added
          .sort()
          .map((k) => `${code(k)} → ${code(carried[k])}`)
          .join(', ')}.`,
      );
    }
    if (direct.length > 0) {
      data.notes.push(
        'pnpm overrides of packages the import added as direct dependencies also changed those ' +
          'dependencies (npm refuses an override that differs from a direct dependency): ' +
          `${direct.join(', ')}.`,
      );
    }
    if (differing.length > 0) {
      data.notes.push(
        `pnpm overrides the workspace already overrides differently (kept): ${differing.join(
          ', ',
        )}.`,
      );
    }
    if (workspaceOwn.length > 0) {
      data.notes.push(
        'pnpm overrides not carried over because the workspace depends on the package directly ' +
          `at another version (npm would refuse the override): ${workspaceOwn.join(', ')}.`,
      );
    }
  }
  if (notCarried.length > 0) {
    data.notes.push(
      'pnpm overrides not carried over automatically (selectors, version ranges, removals, local ' +
        `or workspace specs): ${notCarried.join(', ')}. Rewrite them as npm \`overrides\` ` +
        '(nested for `a>b`) if they are still needed.',
    );
  }
  const fieldPatches = pnpmField['patchedDependencies'];
  const patches = {
    ...(fieldPatches && typeof fieldPatches === 'object'
      ? (fieldPatches as Record<string, unknown>)
      : {}),
    ...(ws?.patchedDependencies ?? {}),
  };
  if (Object.keys(patches).length > 0) {
    data.notes.push(
      `pnpm patches were not applied or copied: ${Object.entries(patches)
        .map(([k, v]) => `${code(k)} (${code(String(v))})`)
        .join(', ')}. Re-create them with \`patch-package\` if the packages still need them.`,
    );
  }
  if (sourceExists(sourceDir, '.pnpmfile.cjs')) {
    data.notes.push(
      'The source `.pnpmfile.cjs` hooks did not run and were not copied; check what they changed.',
    );
  }
  const other = [
    ...(ws?.otherKeys ?? []).map((k) => `pnpm-workspace.yaml \`${k}\``),
    ...Object.keys(pnpmField)
      .filter((k) => k !== 'overrides' && k !== 'patchedDependencies')
      .map((k) => `package.json \`pnpm.${k}\``),
  ];
  if (other.length > 0) {
    data.notes.push(`pnpm settings not carried over: ${other.join(', ')}.`);
  }
}

export const npmWorkspacesAdapter: WorkspaceMigrationAdapter = {
  kind: 'workspace',
  id: 'npm-workspaces',
  label: 'npm, Yarn or pnpm workspaces repo',
  detect: detectNpmWorkspaces,
  defaultName: (sourceDir) => readSourceJson<PackageJson>(sourceDir, 'package.json')?.name,
  preflight: (tree, ctx) => {
    planNpmWorkspaces(tree, ctx);
  },
  migrate: migrateNpmWorkspaces,
};
