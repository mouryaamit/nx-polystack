import * as fs from 'fs';
import * as path from 'path';

/** Messages from a post-build check: errors fail the build, warnings are only listed. */
export interface CheckResult {
  errors: string[];
  warnings: string[];
}

/**
 * Folder holding the served index.html: the output folder, else its browser/ subfolder (Angular
 * application builder), else the output folder itself.
 */
export function servedRoot(distDir: string): string {
  for (const dir of [distDir, path.join(distDir, 'browser')]) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return distDir;
}

/**
 * Files under root whose extension (without the dot, case-insensitive) is in exts. skipDirs are
 * folders relative to root that are not entered. Absolute paths, sorted.
 */
export function listFiles(
  root: string,
  exts: string[],
  opts: { skipDirs?: string[] } = {},
): string[] {
  const wanted = new Set(exts.map((e) => e.toLowerCase()));
  const skipped = new Set((opts.skipDirs ?? []).map((d) => path.resolve(root, d)));
  const found: string[] = [];

  const walk = (dir: string): void => {
    if (skipped.has(dir) || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && wanted.has(path.extname(entry.name).slice(1).toLowerCase())) {
        found.push(full);
      }
    }
  };
  walk(path.resolve(root));
  return found.sort();
}
