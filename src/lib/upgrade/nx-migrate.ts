import * as fs from 'fs';
import * as path from 'path';

/**
 * What `nx migrate` gets wrong on a real workspace, and how pstack puts it right (seen moving a
 * 18-app Angular 15 workspace from Nx 15.9.7 to 17.0.6):
 * - non-interactive, it takes every optional package update, Angular's included; pstack keeps the
 *   Angular packages (and their migrations) where they were, as answering "No" would;
 * - it can write a version with a "v" prefix ("v17.0.6");
 * - it re-lays-out the JSON it touches and text-replaces package names in Markdown and even in
 *   binary files; pstack keeps only the value changes in JSON and puts the rest back;
 * - the newest Nx CLI it downloads refuses older releases (provenance check, version lookup), so
 *   the workspace's own Nx runs the migration first.
 */

/** Nx version of each major `pstack upgrade nx` moves to (one major per step). */
export const NX_HOPS: Readonly<Record<number, string>> = { 16: '16.9.1', 17: '17.0.6' };
export const NX_HOP_MIN = 15;
export const NX_HOP_MAX = 17;

/** Packages that move with the Angular major: `pstack upgrade nx` leaves them alone. */
export function isAngularFamily(name: string): boolean {
  return (
    /^@angular(-devkit|-eslint)?\//.test(name) ||
    /^@(nguniversal|ngrx)\//.test(name) ||
    [
      'angular-eslint',
      '@schematics/angular',
      'ng-packagr',
      'zone.js',
      'typescript',
      'jest-preset-angular',
    ].includes(name)
  );
}

type Json = Record<string, unknown>;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** "v1.2.3" dependency specs written as "1.2.3" (nx migrate writes some); returns the names. */
export function fixVersionPrefixes(pkg: Json): string[] {
  const fixed: string[] = [];
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!isObject(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && /^v\d+\.\d+\.\d+/.test(spec)) {
        deps[name] = spec.slice(1);
        fixed.push(name);
      }
    }
  }
  return fixed;
}

/**
 * `after` with every Angular-family dependency as it was in `before` (changed specs back, added
 * ones removed). Returns the names put back.
 */
export function keepAngularPackages(before: Json, after: Json): string[] {
  const restored: string[] = [];
  fixVersionPrefixes(after);
  for (const field of DEP_FIELDS) {
    const was = isObject(before[field]) ? (before[field] as Json) : {};
    const now = after[field];
    if (!isObject(now)) continue;
    for (const name of Object.keys(now)) {
      if (!isAngularFamily(name)) continue;
      if (!(name in was)) {
        delete now[name];
        restored.push(name);
      } else if (now[name] !== was[name]) {
        now[name] = was[name];
        restored.push(name);
      }
    }
  }
  return [...new Set(restored)].sort();
}

interface Semver {
  satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean;
  coerce(version: string): { version: string } | null;
}

/** semver from the workspace's nx install (it ships with every nx). */
export function loadSemver(root: string): Semver | null {
  for (const from of [root, __dirname]) {
    try {
      const nxPkg = require.resolve('nx/package.json', { paths: [from] });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(require.resolve('semver', { paths: [path.dirname(nxPkg)] })) as Semver;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * Drops from migrations.json the Angular-family packages' migrations and those that require an
 * Angular-family version the workspace keeps (e.g. @nx/angular migrations for Angular 16).
 * Returns the names dropped.
 */
export function filterMigrations(
  file: string,
  kept: (name: string) => string | undefined,
  semver: Semver | null,
): string[] {
  if (!fs.existsSync(file)) return [];
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { migrations?: Json[] };
  const dropped: string[] = [];
  const keep = (m: Json): boolean => {
    const pkg = String(m['package'] ?? '');
    if (isAngularFamily(pkg)) return false;
    const requires = isObject(m['requires']) ? (m['requires'] as Record<string, string>) : {};
    return Object.entries(requires).every(([name, range]) => {
      if (!isAngularFamily(name)) return true;
      const version = kept(name);
      if (!version) return false;
      const v = semver?.coerce(version)?.version;
      return v && semver ? semver.satisfies(v, range, { includePrerelease: true }) : false;
    });
  };
  const migrations = (json.migrations ?? []).filter((m) => {
    if (keep(m)) return true;
    dropped.push(`${m['package']}:${m['name']}`);
    return false;
  });
  fs.writeFileSync(file, JSON.stringify({ ...json, migrations }, null, 2) + '\n');
  return dropped;
}

/** True when the file is not text a migration should edit: Markdown, or bytes that are binary. */
export function isRevertable(root: string, rel: string): boolean {
  if (/\.(md|mdx|markdown)$/i.test(rel)) return true;
  try {
    const buf = fs.readFileSync(path.join(root, rel));
    return buf.subarray(0, 8000).includes(0);
  } catch {
    return false;
  }
}

/** The installed version of a package, else the declared spec (without range characters). */
export function versionOf(root: string, pkg: Json, name: string): string | undefined {
  try {
    const file = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
    const v = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    if (typeof v === 'string') return v.replace(/^v/, '');
  } catch {
    // not installed
  }
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (isObject(deps) && typeof deps[name] === 'string') {
      return (deps[name] as string).replace(/^[\^~=v]+/, '');
    }
  }
  return undefined;
}
