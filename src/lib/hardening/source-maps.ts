import * as fs from 'fs';
import * as path from 'path';

import { CheckResult, listFiles } from './files';
import { CheckMode } from './options';

/** A `//# sourceMappingURL=` or `/*# sourceMappingURL=` comment at the start of a line. */
const SOURCE_MAP_COMMENT = /^[ \t]*(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=([^\s*]*)/gm;

/**
 * Whether a sourceMappingURL comment exposes a map: inline (`data:`), remote, or a .map file that is
 * in the output. A relative URL whose file is not there (a vendored script copied as an asset, its
 * .map left behind) exposes nothing; browsers only get a 404 for it.
 */
function exposesMap(file: string, url: string): boolean {
  if (!url || /^(data|https?):/i.test(url) || url.startsWith('//')) return true;
  const target = path.resolve(path.dirname(file), decodeURIComponent(url.split(/[?#]/)[0]));
  return fs.existsSync(target);
}

/**
 * Source-map guard: *.map files and sourceMappingURL comments (js, mjs, css) under root. One
 * message per file (relative path) plus a hint; fail → errors, warn → warnings, off → nothing.
 * Comments that point at a .map file the output does not have are only warned about (v1.14.0).
 */
export function checkSourceMaps(root: string, mode: CheckMode): CheckResult {
  const result: CheckResult = { errors: [], warnings: [] };
  if (mode === 'off') return result;

  const hits = listFiles(root, ['map']).map((f) => `source map file: ${path.relative(root, f)}`);
  const dangling: string[] = [];
  for (const f of listFiles(root, ['js', 'mjs', 'css'])) {
    const urls = [...fs.readFileSync(f, 'utf8').matchAll(SOURCE_MAP_COMMENT)].map((m) => m[1]);
    if (urls.length === 0) continue;
    if (urls.some((u) => exposesMap(f, u))) {
      hits.push(`sourceMappingURL comment: ${path.relative(root, f)}`);
    } else {
      dangling.push(
        `sourceMappingURL comment without its map (not shipped, nothing exposed): ` +
          `${path.relative(root, f)} → ${urls.join(', ')}`,
      );
    }
  }
  result.warnings.push(...dangling);
  if (!hits.length) return result;

  const messages = [
    ...hits,
    `${hits.length} source map reference(s) in the output; set "sourceMap": false in the Angular build configuration`,
  ];
  if (mode === 'fail') result.errors.push(...messages);
  else result.warnings.push(...messages);
  return result;
}
