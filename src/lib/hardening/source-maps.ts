import * as fs from 'fs';
import * as path from 'path';

import { CheckResult, listFiles } from './files';
import { CheckMode } from './options';

/** A `//# sourceMappingURL=` or `/*# sourceMappingURL=` comment at the start of a line. */
const SOURCE_MAP_COMMENT = /^[ \t]*(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=/m;

/**
 * Source-map guard: *.map files and sourceMappingURL comments (js, mjs, css) under root. One
 * message per file (relative path) plus a hint; fail → errors, warn → warnings, off → nothing.
 */
export function checkSourceMaps(root: string, mode: CheckMode): CheckResult {
  const result: CheckResult = { errors: [], warnings: [] };
  if (mode === 'off') return result;

  const hits = [
    ...listFiles(root, ['map']).map((f) => `source map file: ${path.relative(root, f)}`),
    ...listFiles(root, ['js', 'mjs', 'css'])
      .filter((f) => SOURCE_MAP_COMMENT.test(fs.readFileSync(f, 'utf8')))
      .map((f) => `sourceMappingURL comment: ${path.relative(root, f)}`),
  ];
  if (!hits.length) return result;

  const messages = [
    ...hits,
    `${hits.length} source map reference(s) in the output; set "sourceMap": false in the Angular build configuration`,
  ];
  if (mode === 'fail') result.errors.push(...messages);
  else result.warnings.push(...messages);
  return result;
}
