import * as fs from 'fs';
import * as path from 'path';

/**
 * Environment-specific Apache config for web release builds (Angular, Ionic, Flutter web):
 * environments/<envProject>/htaccess.<env> is copied into the served root as .htaccess. There is
 * no fallback to another env's file or to a generic one.
 */

/** Env folder of a project: environments/<envProject> (workspace-relative). */
export const ENVIRONMENTS_DIR = 'environments';

/** A .htaccess or a per-env copy of one (htaccess.uat, .htaccess.prod, .htaccess.bak, …). */
const HTACCESS_NAME = /^\.?htaccess(\..+)?$/i;

/** environments/<envProject>/htaccess.<env> (workspace-relative, env lower-cased). */
export function htaccessSourcePath(envProject: string, env: string): string {
  return `${ENVIRONMENTS_DIR}/${envProject}/htaccess.${env.toLowerCase()}`;
}

/**
 * The absolute path of the env's .htaccess source. Throws when it is missing, naming the app, the
 * env and the expected file.
 */
export function requireHtaccessSource(
  repoRoot: string,
  app: string,
  envProject: string,
  env: string,
  hint = `set "htaccess": false on its build target to build without one`,
): string {
  const rel = htaccessSourcePath(envProject, env);
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(
      `${app}: the ${env.toLowerCase()} build needs ${rel} (htaccess is on), and it does not ` +
        `exist. Create it (pstack csp --app=${app} writes every env's file), or ${hint}.`,
    );
  }
  return abs;
}

/** The .htaccess-like files under root, relative to root (forward slashes) and sorted. */
export function findHtaccessFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (HTACCESS_NAME.test(entry.name)) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** Removes every .htaccess-like file under root. Returns them (relative to root, sorted). */
export function removeHtaccessFiles(root: string): string[] {
  const found = findHtaccessFiles(root);
  for (const rel of found) fs.rmSync(path.join(root, rel), { force: true });
  return found;
}

/**
 * Puts source into servedDir as .htaccess after removing every other .htaccess-like file from
 * outputDir, then checks that it is the only one. Returns the files that were removed.
 */
export function placeHtaccess(source: string, outputDir: string, servedDir: string): string[] {
  const removed = removeHtaccessFiles(outputDir);
  fs.mkdirSync(servedDir, { recursive: true });
  fs.copyFileSync(source, path.join(servedDir, '.htaccess'));
  const expected = path
    .relative(outputDir, path.join(servedDir, '.htaccess'))
    .split(path.sep)
    .join('/');
  const left = findHtaccessFiles(outputDir);
  if (left.length !== 1 || left[0] !== expected) {
    throw new Error(`htaccess: expected only ${expected} in the output, found ${left.join(', ')}`);
  }
  return removed;
}
