import * as fs from 'fs';
import * as path from 'path';

import { InstallSource, parseInstallSource } from './install-source';
import { PLUGIN_NAME } from './versions';

export interface LocalPlugin {
  /** Package root inside the workspace's node_modules. */
  root: string;
  version: string;
  /** Built CLI entry to delegate to. */
  cliPath: string;
  /**
   * Set when the workspace installs the plugin under another package name (a renamed copy, e.g.
   * from another git server): that name and its package.json pstack.installSource (v1.23.0).
   */
  other?: { name: string; source: InstallSource };
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

/** The plugin installed under `name` in the workspace, or null. */
function installedPlugin(workspaceRoot: string, name: string): LocalPlugin | null {
  const root = path.join(workspaceRoot, 'node_modules', ...name.split('/'));
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
 * A dependency of the workspace that is this plugin under another name: its installed package.json
 * has a `pstack` bin, a pstack.installSource this build understands and a built CLI.
 */
function renamedPlugin(workspaceRoot: string): LocalPlugin | null {
  let names: string[];
  try {
    const ws = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
    names = Object.keys({ ...ws.dependencies, ...ws.devDependencies }).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    if (name === PLUGIN_NAME) continue;
    try {
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(workspaceRoot, 'node_modules', ...name.split('/'), 'package.json'),
          'utf8',
        ),
      );
      if (pkg.name !== name || pkg.bin?.pstack === undefined) continue;
      if (typeof pkg.pstack?.installSource !== 'string') continue;
      const source = parseInstallSource(pkg.pstack.installSource);
      const found = installedPlugin(workspaceRoot, name);
      if (found) return { ...found, other: { name, source } };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The plugin installed in the workspace: under this package's name, else under another name (a
 * renamed copy, found through the workspace's dependencies).
 */
export function resolveLocalPlugin(workspaceRoot: string): LocalPlugin | null {
  return installedPlugin(workspaceRoot, PLUGIN_NAME) ?? renamedPlugin(workspaceRoot);
}

/**
 * Directory that generators.json / migrations.json paths ("./src/...") resolve against:
 * <pkg>/dist when running compiled code, <pkg> when running from source (tests).
 */
export function manifestRoot(selfRoot: string, here: string = __dirname): string {
  const dist = path.join(selfRoot, 'dist');
  return here === dist || here.startsWith(dist + path.sep) ? dist : selfRoot;
}
