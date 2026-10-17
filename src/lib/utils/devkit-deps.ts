import { createRequire } from 'module';

/**
 * `semver` and `ignore` are direct dependencies of @nx/devkit (our peer). Resolving them through
 * @nx/devkit works with hoisted (npm) and strict (pnpm) node_modules layouts alike, without the
 * plugin declaring its own copies.
 */
const fromDevkit = createRequire(require.resolve('@nx/devkit/package.json'));

/** The parts of `semver` we use (typed here so the build needs no @types/semver). */
interface Semver {
  validRange(range: string): string | null;
  intersects(a: string, b: string): boolean;
}

/** The parts of `ignore` we use. */
export interface Ignore {
  add(patterns: string): Ignore;
  ignores(pathname: string): boolean;
}

export const semver: Semver = fromDevkit('semver');
const ignoreModule = fromDevkit('ignore');
export const createIgnore: () => Ignore = ignoreModule.default ?? ignoreModule;

/**
 * True when two version specs can be satisfied together. Ranges that semver understands are
 * compared by intersection (`^15.2.0` and `~15.2.0` overlap); anything else (tags, URLs, `file:`)
 * only matches when the strings are equal.
 */
export function rangesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const ra = semver.validRange(a);
  const rb = semver.validRange(b);
  if (!ra || !rb) return false;
  try {
    return semver.intersects(ra, rb);
  } catch {
    return false;
  }
}
