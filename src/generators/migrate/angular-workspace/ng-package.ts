import * as path from 'path';

type Json = Record<string, unknown>;

/** ng-package.json at its new path: `dest` → the workspace dist folder, `$schema` depth fixed. */
export function rewriteNgPackage(json: Json, file: string, dist: string): Json {
  const dir = path.posix.dirname(file);
  const out: Json = { ...json, dest: path.posix.relative(dir, dist) };
  if (typeof json['$schema'] === 'string') {
    out['$schema'] = path.posix.relative(dir, 'node_modules/ng-packagr/ng-package.schema.json');
  }
  return out;
}
