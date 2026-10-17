import { addDependenciesToPackageJson, GeneratorCallback, readJson, Tree } from '@nx/devkit';

export type Deps = Record<string, string>;

/** Major version of a semver-ish range ("~15.2.0" → 15); undefined when it can't be read. */
export function majorOf(version: string): number | undefined {
  const m = /^\D*(\d+)(?:[.\s]|$)/.exec(version.trim());
  return m ? Number(m[1]) : undefined;
}

/** Version declared for `name` in dependencies or devDependencies. */
export function declaredVersion(tree: Tree, name: string): string | undefined {
  const pkg = readJson(tree, 'package.json');
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
}

/**
 * The workspace's nx version, for the @nx/* packages that must match it exactly: the installed
 * version from node_modules when present, else the declared range, else ^17.0.0.
 */
export function nxVersion(tree: Tree): string {
  if (tree.exists('node_modules/nx/package.json')) {
    const installed = readJson(tree, 'node_modules/nx/package.json').version;
    if (typeof installed === 'string') return installed;
  }
  return declaredVersion(tree, 'nx') ?? '^17.0.0';
}

/**
 * Adds only the packages that are not declared yet (in either field) and never changes an
 * existing version. Returns the install callback, or undefined when nothing was added.
 */
export function addMissingDependencies(
  tree: Tree,
  deps: Deps,
  devDeps: Deps,
): GeneratorCallback | undefined {
  const missing = (wanted: Deps): Deps =>
    Object.fromEntries(
      Object.entries(wanted).filter(([name]) => declaredVersion(tree, name) === undefined),
    );
  const d = missing(deps);
  const dd = missing(devDeps);
  if (Object.keys(d).length === 0 && Object.keys(dd).length === 0) return undefined;
  return addDependenciesToPackageJson(tree, d, dd);
}

/** ESLint stack every workspace needs for the root .eslintrc.json (same versions as the sample). */
export function lintDependencies(nx: string): Deps {
  return {
    eslint: '^8.57.0',
    '@nx/eslint': nx,
    '@nx/eslint-plugin': nx,
    '@typescript-eslint/eslint-plugin': '^5.62.0',
    '@typescript-eslint/parser': '^5.62.0',
    'eslint-config-prettier': '^9.1.0',
  };
}

export function ensureLintDependencies(tree: Tree): GeneratorCallback | undefined {
  return addMissingDependencies(tree, {}, lintDependencies(nxVersion(tree)));
}

/** terser: loaded from the workspace by the release target's comment and console stripping. */
export const RELEASE_HARDENING_DEV_DEPENDENCIES: Deps = { terser: '^5.16.0' };

export function ensureReleaseHardeningDependencies(tree: Tree): GeneratorCallback | undefined {
  return addMissingDependencies(tree, {}, RELEASE_HARDENING_DEV_DEPENDENCIES);
}

/** javascript-obfuscator: loaded from the workspace by the release target's obfuscate step. */
export const OBFUSCATION_DEV_DEPENDENCIES: Deps = { 'javascript-obfuscator': '^4.2.2' };

export function ensureObfuscationDependencies(tree: Tree): GeneratorCallback | undefined {
  return addMissingDependencies(tree, {}, OBFUSCATION_DEV_DEPENDENCIES);
}
