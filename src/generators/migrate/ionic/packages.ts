import { readSourceJson, type PackageJson } from '../source';

/** Name patterns of packages with native code (Capacitor and Cordova plugins, the Capacitor CLI). */
const NATIVE = [
  /^@capacitor\//,
  /^@capawesome(-team)?\//,
  /capacitor/i,
  /^cordova-/,
  /^@awesome-cordova-plugins\//,
  /^@ionic-native\//,
];

/** Nx plugins for Capacitor (e.g. @nxext/capacitor) are build tooling, not native packages. */
const NX_PLUGIN = /^@(nx|nrwl|nxext)\//;

/** Native by name alone. */
export const isNativePackage = (name: string): boolean =>
  !NX_PLUGIN.test(name) && NATIVE.some((re) => re.test(name));

/**
 * Code files whose imports count for the web build: not the Capacitor config, which the
 * Capacitor CLI loads from the app folder (it imports @capacitor/cli for its types).
 */
export const isWebCodeFile = (file: string): boolean =>
  /\.(ts|tsx|mts|js|mjs|cjs)$/.test(file) && !/(^|\/)capacitor\.config\.[cm]?[jt]s$/.test(file);

/**
 * Native by name, or because the installed package (source node_modules, when present) declares
 * a `capacitor` or `cordova` section, as Capacitor and Cordova plugins do.
 */
export function nativeClassifier(sourceDir: string): (name: string) => boolean {
  const cache = new Map<string, boolean>();
  return (name) => {
    if (isNativePackage(name)) return true;
    if (NX_PLUGIN.test(name)) return false;
    let native = cache.get(name);
    if (native === undefined) {
      const pkg = readSourceJson<Record<string, unknown>>(
        sourceDir,
        `node_modules/${name}/package.json`,
      );
      native = !!pkg && (pkg['capacitor'] !== undefined || pkg['cordova'] !== undefined);
      cache.set(name, native);
    }
    return native;
  };
}

/** Packages every Capacitor app needs whether or not its code imports them. */
export const PLATFORM_PACKAGES = new Set([
  '@capacitor/core',
  '@capacitor/cli',
  '@capacitor/android',
  '@capacitor/ios',
]);

export const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
export type DepField = (typeof DEP_FIELDS)[number];

export type NativeDeps = Record<DepField, Record<string, string>>;

export interface NativeSplit {
  native: NativeDeps;
  /** Native package names, sorted, each once. */
  names: string[];
}

/**
 * The native packages of `pkg`, by field. A package in several fields is kept in the first one
 * (dependencies, then devDependencies, then optionalDependencies). `keep` narrows the set.
 */
export function splitNativePackages(
  pkg: PackageJson | undefined,
  isNative: (name: string) => boolean = isNativePackage,
  keep: (name: string) => boolean = () => true,
): NativeSplit {
  const native: NativeDeps = { dependencies: {}, devDependencies: {}, optionalDependencies: {} };
  const seen = new Set<string>();
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(pkg?.[field] ?? {})) {
      if (seen.has(name) || !isNative(name) || !keep(name)) continue;
      seen.add(name);
      native[field][name] = spec;
    }
  }
  return { native, names: [...seen].sort() };
}

/** Native packages of `pkg` (every dependency field), sorted. */
export function nativePackageNames(
  pkg: PackageJson | undefined,
  isNative: (name: string) => boolean = isNativePackage,
): string[] {
  return splitNativePackages(pkg, isNative).names;
}

/** cordova-plugin-* packages, sorted. */
export function cordovaPlugins(pkg: PackageJson | undefined): string[] {
  return DEP_FIELDS.flatMap((f) => Object.keys(pkg?.[f] ?? {}))
    .filter((n, i, all) => n.startsWith('cordova-plugin-') && all.indexOf(n) === i)
    .sort();
}

/** The npm package an import specifier names: `@scope/name` or `name`. */
export function packageOfSpecifier(spec: string): string {
  return spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');
}
