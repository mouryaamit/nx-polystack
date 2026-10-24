import * as fs from 'fs';
import * as path from 'path';

/** Version of a package installed in the workspace's node_modules ("v" prefix dropped). */
export function installedVersion(root: string, name: string): string | undefined {
  try {
    const file = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
    const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof version === 'string' ? version.replace(/^v/, '') : undefined;
  } catch {
    return undefined;
  }
}

type Deps = Record<string, unknown>;

/** The spec a package.json declares for `name` (dependencies, devDependencies, optional). */
export function declaredSpec(pkg: Record<string, unknown>, name: string): string | undefined {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[field] as Deps | undefined;
    if (deps && typeof deps === 'object' && typeof deps[name] === 'string') {
      return deps[name] as string;
    }
  }
  return undefined;
}

/**
 * The @nx/devkit version to pin, or null: the plugin needs @nx/devkit of the workspace's Nx, and
 * npm resolves the plugin's devkit peer to the newest one when the workspace does not declare it
 * (or declares a range). `nxVersion` is the installed nx (or the one about to be).
 */
export function devkitPinFor(
  pkg: Record<string, unknown>,
  nxVersion: string | undefined,
): string | null {
  if (!nxVersion || !/^\d+\.\d+\.\d+/.test(nxVersion)) return null;
  return declaredSpec(pkg, '@nx/devkit') === nxVersion ? null : nxVersion;
}

/**
 * package.json with @nx/devkit set to `version` in the field that has it (else next to nx, else
 * devDependencies), new keys in alphabetical place when that field is sorted.
 */
export function withDevkitPin(
  pkg: Record<string, unknown>,
  version: string,
): Record<string, unknown> {
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies'];
  const has = (f: string, name: string) =>
    typeof pkg[f] === 'object' && pkg[f] !== null && name in (pkg[f] as Deps);
  const field =
    fields.find((f) => has(f, '@nx/devkit')) ??
    fields.find((f) => has(f, 'nx')) ??
    'devDependencies';
  const deps = { ...((pkg[field] as Deps | undefined) ?? {}) };
  const keys = Object.keys(deps);
  const sorted = keys.every((k, i) => i === 0 || keys[i - 1].localeCompare(k) <= 0);
  deps['@nx/devkit'] = version;
  const next = sorted
    ? Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)))
    : deps;
  return { ...pkg, [field]: next };
}
