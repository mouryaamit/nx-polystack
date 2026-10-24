import { compareVersions } from './versions';

interface ManifestEntry {
  version: string;
  description?: string;
  implementation?: string;
}

export interface MigrationsManifest {
  generators?: Record<string, ManifestEntry>;
}

export interface MigrationEntry {
  name: string;
  version: string;
  description?: string;
  /** Path relative to the manifest directory. */
  implementation: string;
}

export interface MigrationResult {
  applied: string[];
  failed?: { name: string; error: string };
}

export function selectMigrations(
  manifest: MigrationsManifest,
  from: string,
  to: string,
): MigrationEntry[] {
  return Object.entries(manifest.generators ?? {})
    .filter(([, e]) => !!e.implementation)
    .filter(([, e]) => compareVersions(e.version, from) > 0 && compareVersions(e.version, to) <= 0)
    .map(([name, e]) => ({
      name,
      version: e.version,
      description: e.description,
      implementation: e.implementation as string,
    }))
    .sort((a, b) => compareVersions(a.version, b.version) || a.name.localeCompare(b.name));
}

/** Every migration of the manifest, oldest first. */
export function allMigrations(manifest: MigrationsManifest): MigrationEntry[] {
  return selectMigrations(manifest, '0.0.0', '999999.0.0');
}

/**
 * The named migrations (any version), in release order. Throws with the known names when one is
 * not in the manifest.
 */
export function namedMigrations(manifest: MigrationsManifest, names: string[]): MigrationEntry[] {
  const all = allMigrations(manifest);
  const unknown = names.filter((n) => !all.some((e) => e.name === n));
  if (unknown.length > 0) {
    throw new Error(
      `no migration named ${unknown.map((n) => `"${n}"`).join(', ')}. Known: ${all
        .map((e) => e.name)
        .join(', ')}`,
    );
  }
  return all.filter((e) => names.includes(e.name));
}

export async function runMigrations(
  entries: MigrationEntry[],
  runOne: (e: MigrationEntry) => Promise<void>,
): Promise<MigrationResult> {
  const applied: string[] = [];
  for (const e of entries) {
    try {
      await runOne(e);
      applied.push(e.name);
    } catch (err) {
      return {
        applied,
        failed: { name: e.name, error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  return { applied };
}
