import { GeneratorCallback, names, offsetFromRoot, readJson, Tree, writeJson } from '@nx/devkit';

import { assertDirOutsideProjects, parseDir } from '../../lib/utils/app-dir';
import { workspaceNpmScope } from '../../lib/utils/workspace';

import { LibGeneratorSchema, LibType } from './schema.d';

export type LibPlatform = 'web' | 'mobile' | 'flutter' | 'any';

/** Everything a lib type needs, resolved from the raw options. */
export interface NormalizedLibOptions {
  /** kebab-case name as given */
  name: string;
  type: LibType;
  scope: string;
  /** directory name under libs/<scope>/ (snake_case for flutter, else the name) */
  dir: string;
  /** --dir: folders between the scope folder and the library folder, if any */
  folder?: string;
  /** libs/<scope>/<dir>, or libs/<scope>/<folder>/<dir> */
  projectRoot: string;
  /** <scope>-<name> */
  projectName: string;
  /** @<npmScope>/<scope>-<name> */
  importPath: string;
  npmScope: string;
  /** relative path from projectRoot back to the workspace root, with trailing slash */
  offset: string;
  variant?: string;
  prefix: string;
  tags: string[];
  /** names(name): fileName (kebab), className (Pascal), propertyName (camel) */
  fileName: string;
  className: string;
  propertyName: string;
  /** snake_case of the name (Dart package / file names) */
  snakeName: string;
  /** --standalone / --module (Angular-based types); unset: the workspace style. */
  standalone?: boolean;
  module?: boolean;
}

/** Per-type behaviour, registered in types/index.ts. */
export interface LibTypeSpec {
  defaultScope: string;
  platform: LibPlatform;
  /** maps the import alias in tsconfig.base.json */
  tsPath: boolean;
  /** directory naming under libs/<scope>/ */
  dirCase: 'kebab' | 'snake';
  /** allowed --variant values; the first is not implied — see defaultVariant */
  variants?: readonly string[];
  defaultVariant?: string;
  /** --variant values that are known but refused, with the reason */
  rejectedVariants?: Record<string, string>;
  generate(tree: Tree, o: NormalizedLibOptions): GeneratorCallback | undefined;
  /** Writes files that must keep their exact content (e.g. tool output), after Prettier ran. */
  afterFormat?(tree: Tree, o: NormalizedLibOptions): void;
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export { workspaceNpmScope };

export function tsPathExists(tree: Tree, alias: string): boolean {
  if (!tree.exists('tsconfig.base.json')) return false;
  const paths = readJson(tree, 'tsconfig.base.json').compilerOptions?.paths ?? {};
  return Object.prototype.hasOwnProperty.call(paths, alias);
}

/**
 * Whether a project.json under apps/ or libs/ already uses `name`. Walks the tree instead of
 * getProjects(), which needs Nx's native file globbing.
 */
export function projectNameTaken(tree: Tree, name: string): boolean {
  const visit = (dir: string, depth: number): boolean => {
    const pj = `${dir}/project.json`;
    if (tree.exists(pj) && tree.isFile(pj)) {
      try {
        if (readJson(tree, pj).name === name) return true;
      } catch {
        // unreadable project.json — not ours to judge
      }
    }
    if (depth === 0) return false;
    return tree
      .children(dir)
      .filter((c) => c !== 'node_modules' && !c.startsWith('.') && !tree.isFile(`${dir}/${c}`))
      .some((c) => visit(`${dir}/${c}`, depth - 1));
  };
  return ['apps', 'libs'].some((root) => tree.exists(root) && visit(root, 4));
}

/** Library types whose Angular code comes as NgModules or standalone components. */
export const ANGULAR_STYLE_TYPES: readonly string[] = [
  'angular',
  'ionic',
  'pii',
  'session',
  'state',
];

export function normalizeOptions(
  tree: Tree,
  schema: LibGeneratorSchema,
  spec: LibTypeSpec,
): NormalizedLibOptions {
  const { name, type } = schema;
  if (!name || !KEBAB.test(name)) {
    throw new Error(
      `lib generator: --name="${
        name ?? ''
      }" must be kebab-case (lowercase letters, digits and dashes, starting with a letter).`,
    );
  }
  const scope = schema.scope ?? spec.defaultScope;
  if (!KEBAB.test(scope)) {
    throw new Error(`lib generator: --scope="${scope}" must be kebab-case.`);
  }
  // --dir: under libs/<scope>/, so at most 2 folders keep the library within the 4-level scans.
  const folder = parseDir(schema.dir, 'lib generator', 2);
  // A project at libs/<scope> (e.g. a migrated library named like a scope) would contain this one.
  const scopeRoot = `libs/${scope}`;
  if (tree.exists(`${scopeRoot}/project.json`) || tree.exists(`${scopeRoot}/pubspec.yaml`)) {
    throw new Error(
      `lib generator: "${scopeRoot}" is a project; libraries cannot be nested in it. Pick another --scope.`,
    );
  }
  if (folder) assertDirOutsideProjects(tree, folder, 'lib generator', scopeRoot);
  const prefix = schema.prefix ?? 'lib';
  if (!KEBAB.test(prefix)) {
    throw new Error(`lib generator: --prefix="${prefix}" must be kebab-case.`);
  }

  if ((schema.standalone || schema.module) && !ANGULAR_STYLE_TYPES.includes(type)) {
    throw new Error(
      `lib generator: --standalone and --module are for ${ANGULAR_STYLE_TYPES.join(
        ', ',
      )} libraries.`,
    );
  }

  let variant: string | undefined;
  if (spec.variants) {
    variant = schema.variant ?? spec.defaultVariant;
    const rejected = variant ? spec.rejectedVariants?.[variant] : undefined;
    if (rejected) {
      throw new Error(`lib generator: --variant=${variant} ${rejected}`);
    }
    if (!variant || !spec.variants.includes(variant)) {
      throw new Error(
        `lib generator: --variant="${variant}" is not valid for --type=${type}. ` +
          `Use one of: ${spec.variants.join(', ')}.`,
      );
    }
  } else if (schema.variant !== undefined) {
    throw new Error(
      `lib generator: --type=${type} has no variants (got --variant="${schema.variant}").`,
    );
  }

  const n = names(name);
  const snakeName = name.replace(/-/g, '_');
  const dir = spec.dirCase === 'snake' ? snakeName : name;
  const projectRoot = folder ? `libs/${scope}/${folder}/${dir}` : `libs/${scope}/${dir}`;
  const projectName = `${scope}-${name}`;
  const npmScope = workspaceNpmScope(tree);
  const importPath = `@${npmScope}/${projectName}`;

  if (tree.exists(projectRoot)) {
    throw new Error(
      `lib generator: "${projectRoot}" already exists` +
        (tree.exists(`${projectRoot}/project.json`)
          ? '.'
          : ' (it holds other libraries). Pick another --name.'),
    );
  }
  if (projectNameTaken(tree, projectName)) {
    throw new Error(`lib generator: a project named "${projectName}" already exists.`);
  }
  if (spec.tsPath && tsPathExists(tree, importPath)) {
    throw new Error(
      `lib generator: import alias "${importPath}" is already mapped in tsconfig.base.json.`,
    );
  }

  const tags = Array.from(
    new Set([
      `scope:${scope}`,
      `type:${type}`,
      `platform:${spec.platform}`,
      ...(schema.tags ?? []),
    ]),
  );

  return {
    name,
    type,
    scope,
    dir,
    folder,
    projectRoot,
    projectName,
    importPath,
    npmScope,
    offset: offsetFromRoot(projectRoot),
    variant,
    prefix,
    tags,
    fileName: n.fileName,
    className: n.className,
    propertyName: n.propertyName,
    snakeName,
    standalone: schema.standalone,
    module: schema.module,
  };
}

/** Writes <projectRoot>/project.json for a library. */
export function writeLibProjectJson(
  tree: Tree,
  o: NormalizedLibOptions,
  extra: { sourceRoot: string; targets: Record<string, unknown>; prefix?: string },
): void {
  writeJson(tree, `${o.projectRoot}/project.json`, {
    name: o.projectName,
    $schema: `${o.offset}node_modules/nx/schemas/project-schema.json`,
    sourceRoot: extra.sourceRoot,
    projectType: 'library',
    ...(extra.prefix ? { prefix: extra.prefix } : {}),
    tags: o.tags,
    targets: extra.targets,
  });
}

/** `@nx/eslint:lint` target over the given globs (relative to the project root). */
export function lintTarget(o: NormalizedLibOptions, globs: string[]): Record<string, unknown> {
  return {
    executor: '@nx/eslint:lint',
    outputs: ['{options.outputFile}'],
    options: { lintFilePatterns: globs.map((g) => `${o.projectRoot}/${g}`) },
  };
}

/** Template substitutions shared by every lib type. */
export function templateVars(o: NormalizedLibOptions): Record<string, unknown> {
  const title = o.className.replace(/([A-Z])/g, ' $1').trim();
  return { ...o, title, template: '' };
}

/** Runs the defined callbacks in order; undefined when there are none. */
export function combineTasks(
  ...tasks: (GeneratorCallback | undefined)[]
): GeneratorCallback | undefined {
  const defined = tasks.filter((t): t is GeneratorCallback => typeof t === 'function');
  if (defined.length === 0) return undefined;
  return async () => {
    for (const task of defined) await task();
  };
}

/** "~15.1.0" → "^15.1.0"; falls back to `fallback` when no x.y.z can be read. */
export function caretRange(version: string | undefined, fallback: string): string {
  const m = version ? /(\d+\.\d+\.\d+)/.exec(version) : null;
  return m ? `^${m[1]}` : fallback;
}
