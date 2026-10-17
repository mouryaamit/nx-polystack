import * as fs from 'fs';
import * as path from 'path';

import { PLUGIN_NAME } from './versions';

export interface LocalPlugin {
  /** Package root inside the workspace's node_modules. */
  root: string;
  version: string;
  /** Built CLI entry to delegate to. */
  cliPath: string;
}

/** Walk up from `start` until a directory containing nx.json is found. */
export function findWorkspaceRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'nx.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readPackageVersion(pkgJsonPath: string): string {
  const version = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
  if (typeof version !== 'string') throw new Error(`${pkgJsonPath} has no "version"`);
  return version;
}

/** Root of the running @mouryaamit/nx-polystack package (works from source and from dist/). */
export function selfPackageRoot(from: string = __dirname): string {
  let dir = from;
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).name === PLUGIN_NAME) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot locate ${PLUGIN_NAME} package.json above ${from}`);
    dir = parent;
  }
}

export function resolveLocalPlugin(workspaceRoot: string): LocalPlugin | null {
  const root = path.join(workspaceRoot, 'node_modules', ...PLUGIN_NAME.split('/'));
  const pkg = path.join(root, 'package.json');
  const cliPath = path.join(root, 'dist', 'bin', 'cli.js');
  if (!fs.existsSync(pkg) || !fs.existsSync(cliPath)) return null;
  try {
    return { root, version: readPackageVersion(pkg), cliPath };
  } catch {
    return null;
  }
}

/**
 * Directory that generators.json / migrations.json paths ("./src/...") resolve against:
 * <pkg>/dist when running compiled code, <pkg> when running from source (tests).
 */
export function manifestRoot(selfRoot: string, here: string = __dirname): string {
  const dist = path.join(selfRoot, 'dist');
  return here === dist || here.startsWith(dist + path.sep) ? dist : selfRoot;
}
