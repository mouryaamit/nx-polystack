import * as path from 'path';

import type { AliasMap } from '../nx/selection';

export interface LibraryTargets {
  root: string;
  /** Relative to the library root. */
  entryFile: string;
  /** Build output folders (source-relative). */
  outputs: string[];
  /** Entry file of a secondary entry point folder (relative to it); default src/public-api.ts. */
  secondaryEntry?: (sub: string) => string;
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/**
 * Alias targets in a library's build output → the library source (source-relative): the output
 * folder → the entry file; `<output>/<sub>` (a secondary entry point) → `<lib>/<sub>/<its entry>`;
 * a wildcard under the output folder → the same wildcard under the library, then src/public-api.ts.
 */
export function aliasesToSource(aliases: AliasMap, libs: LibraryTargets[]): AliasMap {
  const toSource = (t: string): string => {
    for (const lib of libs) {
      for (const o of lib.outputs) {
        if (t === o) return path.posix.join(lib.root, lib.entryFile);
        if (!t.startsWith(`${o}/`)) continue;
        const sub = t.slice(o.length + 1);
        if (sub === '*') return `${lib.root}/*/src/public-api.ts`;
        const entry = lib.secondaryEntry?.(sub) ?? 'src/public-api.ts';
        return path.posix.join(lib.root, sub, entry);
      }
    }
    return t;
  };
  const out: AliasMap = {};
  for (const [alias, targets] of Object.entries(aliases)) {
    out[alias] = [...new Set(targets.map(toSource))];
  }
  return out;
}

export interface Rerooted {
  root: string;
  newRoot: string;
}

/**
 * Source-relative alias targets → workspace paths. A target maps when it is inside a copied
 * project (the most specific root; a root project owns what no other project owns, outside
 * the paths of non-copied projects listed in `excluded`). Aliases with any unmappable target
 * are listed in `unmapped`.
 */
export function rerootAliases(
  aliases: AliasMap,
  projects: Rerooted[],
  excluded: string[] = [],
): { mapped: AliasMap; unmapped: string[] } {
  const mapped: AliasMap = {};
  const unmapped: string[] = [];
  const reroot = (t: string): string | undefined => {
    const n = path.posix.normalize(t);
    // Packages are not project files: kept as they are (e.g. "@angular/*": ["node_modules/@angular/*"]).
    if (n === 'node_modules' || n.startsWith('node_modules/')) return n;
    if (n.startsWith('../')) return undefined;
    const owner = projects
      .filter((p) => p.root !== '' && inside(n, p.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
    // A root project owns what no copied project and no excluded folder owns.
    const rootProject = projects.find((p) => p.root === '');
    const chosen =
      owner ?? (rootProject && !excluded.some((e) => inside(n, e)) ? rootProject : undefined);
    if (!chosen) return undefined;
    const rest = chosen.root ? n.slice(chosen.root.length).replace(/^\//, '') : n;
    return rest ? `${chosen.newRoot}/${rest}` : chosen.newRoot;
  };
  for (const [alias, targets] of Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const out = targets.map(reroot);
    if (out.every((t): t is string => t !== undefined)) mapped[alias] = out;
    else unmapped.push(alias);
  }
  return { mapped, unmapped };
}
