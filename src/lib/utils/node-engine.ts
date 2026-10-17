import { Tree } from '@nx/devkit';

/** The Node major the workspace pins in `.nvmrc` (`20`, `v20.11.0`), or undefined (none, `lts/*`). */
export function workspaceNodeMajor(tree: Tree): number | undefined {
  const text = tree.exists('.nvmrc') ? tree.read('.nvmrc', 'utf8')?.trim() ?? '' : '';
  const m = /^v?(\d+)(?:\.\d+){0,2}$/.exec(text);
  return m ? Number(m[1]) : undefined;
}

type Check = (major: number) => boolean;

/** One comparator (`>=18`, `^18.2`, `18.x`, `<21`) as a check on a major version; undefined if unknown. */
function comparator(c: string): Check | undefined {
  if (/^[xX*](\.[xX*]){0,2}$/.test(c)) return () => true;
  // A prerelease or build suffix (`-0`, `+abc`) does not change which majors are allowed.
  const m =
    /^(>=|<=|>|<|\^|~|=)?v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(
      c,
    );
  if (!m) return undefined;
  const [, op = '', majorText, minor, patch] = m;
  const x = Number(majorText);
  const rest = [minor, patch].some((p) => p !== undefined && /^\d+$/.test(p) && Number(p) > 0);
  switch (op) {
    case '>=':
      return (v) => v >= x;
    case '>':
      // `>18` and `>18.x` mean >=19.0.0; `>18.0` and `>18.0.0` still allow 18.
      return minor === undefined || !/^\d+$/.test(minor) ? (v) => v > x : (v) => v >= x;
    case '<':
      return rest ? (v) => v <= x : (v) => v < x;
    case '<=':
      return (v) => v <= x;
    default:
      // ^X, ~X, =X, X, X.x, X.Y.Z: within major X.
      return (v) => v === x;
  }
}

/**
 * Whether some version of Node `major` satisfies an npm `engines.node` range. Covers the usual
 * forms (`18.x`, `^18`, `>=18`, `>=18 <21`, `18 || 20`, hyphen ranges); undefined when the range
 * is something else.
 */
export function nodeRangeAllowsMajor(range: string, major: number): boolean | undefined {
  const alternatives = range.split('||').map((a) => a.trim());
  let unknown = false;
  for (const alt of alternatives) {
    if (alt === '') return true;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alt);
    const parts = hyphen
      ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
      : alt.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/);
    const checks = parts.map(comparator);
    if (checks.some((c) => c === undefined)) {
      unknown = true;
      continue;
    }
    if ((checks as Check[]).every((c) => c(major))) return true;
  }
  return unknown ? undefined : false;
}
