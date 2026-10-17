import { parsePnpmYaml, YamlValue } from './npm-workspaces/pnpm-yaml';
import { PackageJson, readSourceJson, readSourceText } from './source';

/** pnpm-workspace.yaml and `catalog:` specs, shared by the workspace adapters. */

/** What :migrate reads from pnpm-workspace.yaml. */
export interface PnpmWorkspace {
  /** `packages` globs; undefined when the key is missing. */
  packages?: string[];
  /** Catalog name ("default" for `catalog`) → package → version. */
  catalogs: Record<string, Record<string, string>>;
  /** `overrides` entries (values as written). */
  overrides: Record<string, string>;
  /** `patchedDependencies` entries: package → patch file. */
  patchedDependencies: Record<string, string>;
  /** The other top-level keys (settings not carried over). */
  otherKeys: string[];
}

const isMap = (v: YamlValue | undefined): v is Record<string, YamlValue> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const stringEntries = (v: YamlValue | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!isMap(v)) return out;
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
};

const PNPM_READ_KEYS = ['packages', 'catalog', 'catalogs', 'overrides', 'patchedDependencies'];

/**
 * pnpm-workspace.yaml, or undefined when the source has none. Throws (naming the file) when it
 * cannot be read.
 */
export function readPnpmWorkspace(sourceDir: string): PnpmWorkspace | undefined {
  const text = readSourceText(sourceDir, 'pnpm-workspace.yaml');
  if (text === undefined) return undefined;
  let doc: Record<string, YamlValue>;
  try {
    doc = parsePnpmYaml(text);
  } catch (err) {
    throw new Error(
      `migrate: cannot read pnpm-workspace.yaml (${(err as Error).message}). Simplify that ` +
        'part of the file and run the import again.',
    );
  }
  const packages = Array.isArray(doc['packages'])
    ? doc['packages'].filter((g): g is string => typeof g === 'string' && g.trim() !== '')
    : undefined;
  const catalogs: Record<string, Record<string, string>> = {};
  if (isMap(doc['catalogs'])) {
    for (const [name, entries] of Object.entries(doc['catalogs'])) {
      catalogs[name] = stringEntries(entries);
    }
  }
  if (isMap(doc['catalog'])) {
    catalogs['default'] = { ...(catalogs['default'] ?? {}), ...stringEntries(doc['catalog']) };
  }
  return {
    packages,
    catalogs,
    overrides: stringEntries(doc['overrides']),
    patchedDependencies: stringEntries(doc['patchedDependencies']),
    otherKeys: Object.keys(doc).filter((k) => !PNPM_READ_KEYS.includes(k)),
  };
}

/** pnpm-workspace.yaml when it can be read; undefined when it is missing or broken. */
export function pnpmWorkspaceOrNothing(sourceDir: string): PnpmWorkspace | undefined {
  try {
    return readPnpmWorkspace(sourceDir);
  } catch {
    return undefined;
  }
}

const CATALOG = /^catalog:(.*)$/;

/**
 * A package.json with its pnpm `catalog:` / `catalog:<name>` specs replaced by the catalog's
 * versions; the specs that name no entry stay and are listed as "dep (catalog:x)".
 */
export function resolveCatalogs<T extends PackageJson>(
  pkg: T,
  catalogs: Record<string, Record<string, string>>,
): { pkg: T; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = { ...pkg };
  // peerDependencies are never merged, so an unknown entry there does not count.
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const) {
    const deps = pkg[field];
    if (!deps) continue;
    const next: Record<string, string> = {};
    for (const [name, spec] of Object.entries(deps)) {
      const m = typeof spec === 'string' ? CATALOG.exec(spec.trim()) : null;
      if (!m) {
        next[name] = spec;
        continue;
      }
      const version = catalogs[m[1].trim() || 'default']?.[name];
      if (version === undefined || version === '' || CATALOG.test(version)) {
        if (field !== 'peerDependencies') unresolved.push(`${name} (${spec.trim()})`);
        next[name] = spec;
      } else next[name] = version;
    }
    (out as PackageJson)[field] = next;
  }
  return { pkg: out, unresolved };
}

/** Catalogs to resolve `catalog:` specs against: none without a readable pnpm-workspace.yaml. */
export function sourceCatalogs(sourceDir: string): Record<string, Record<string, string>> {
  return pnpmWorkspaceOrNothing(sourceDir)?.catalogs ?? {};
}

/**
 * Like sourceCatalogs, but a pnpm-workspace.yaml that cannot be read throws its parse error
 * (for preflights, so the refusal names the real problem).
 */
function readableCatalogs(sourceDir: string): Record<string, Record<string, string>> {
  return readPnpmWorkspace(sourceDir)?.catalogs ?? {};
}

/**
 * The source root package.json with `catalog:` specs resolved. Without pnpm catalogs (no
 * pnpm-workspace.yaml, or Yarn catalogs, which are not read) every `catalog:` spec is unresolved.
 */
export function sourceRootPackage<T extends PackageJson = PackageJson>(
  sourceDir: string,
): { pkg: T | undefined; unresolved: string[] } {
  const pkg = readSourceJson<T>(sourceDir, 'package.json');
  if (!pkg) return { pkg, unresolved: [] };
  return resolveCatalogs(pkg, readableCatalogs(sourceDir));
}

/** The refusal for `catalog:` specs that name no catalog entry. */
export function catalogMissMessage(owner: string, misses: string[]): string {
  return (
    `${owner} uses catalog entries that no pnpm-workspace.yaml catalog defines: ` +
    `${misses.join(', ')}. (Yarn catalogs are not read.)`
  );
}
