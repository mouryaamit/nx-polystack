import { logger, Tree } from '@nx/devkit';

const KNIP_JSON = 'knip.json';
const PRINT_WIDTH = 100;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const isPlainArray = (v: Json[]): boolean => v.every((x) => x === null || typeof x !== 'object');

/**
 * JSON in the shape Prettier prints it (printWidth 100, the preset's): objects one key per line,
 * arrays of plain values on one line when they fit, else one value per line.
 */
export function formatKnipJson(value: Json): string {
  const print = (v: Json, indent: string, prefix: string, suffix: string): string => {
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      if (v.length === 0) return `${prefix}[]${suffix}`;
      if (isPlainArray(v)) {
        const oneLine = `${prefix}[${v.map((x) => JSON.stringify(x)).join(', ')}]${suffix}`;
        if (oneLine.length <= PRINT_WIDTH) return oneLine;
      }
      const items = v.map((x, i) => print(x, inner, inner, i < v.length - 1 ? ',' : ''));
      return `${prefix}[\n${items.join('\n')}\n${indent}]${suffix}`;
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      if (entries.length === 0) return `${prefix}{}${suffix}`;
      const items = entries.map(([k, x], i) =>
        print(x, inner, `${inner}${JSON.stringify(k)}: `, i < entries.length - 1 ? ',' : ''),
      );
      return `${prefix}{\n${items.join('\n')}\n${indent}}${suffix}`;
    }
    return `${prefix}${JSON.stringify(v)}${suffix}`;
  };
  return `${print(value, '', '', '')}\n`;
}

/**
 * Adds paths to the `ignore` array of an existing knip.json (deduped; the array is created when
 * missing). A missing knip.json is left missing; one that is not a plain JSON object with an array
 * (or no) `ignore` is left untouched with a warning. Returns true when the file changed.
 */
export function addKnipIgnores(tree: Tree, entries: string[]): boolean {
  if (!tree.exists(KNIP_JSON)) return false;
  let json: { [key: string]: Json };
  try {
    json = JSON.parse(tree.read(KNIP_JSON, 'utf8') ?? '');
  } catch {
    logger.warn(
      `${KNIP_JSON} is not plain JSON; add these to its "ignore" list: ${entries.join(', ')}`,
    );
    return false;
  }
  const current = json?.['ignore'];
  if (
    !json ||
    typeof json !== 'object' ||
    Array.isArray(json) ||
    (current !== undefined && !Array.isArray(current))
  ) {
    logger.warn(
      `${KNIP_JSON} has an unexpected shape; add these to its "ignore" list: ${entries.join(', ')}`,
    );
    return false;
  }
  const ignore = (current ?? []) as Json[];
  const missing = entries.filter((e, i) => !ignore.includes(e) && entries.indexOf(e) === i);
  if (missing.length === 0) return false;
  json['ignore'] = [...ignore, ...missing];
  tree.write(KNIP_JSON, formatKnipJson(json));
  return true;
}
