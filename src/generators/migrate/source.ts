import * as fs from 'fs';
import * as path from 'path';

import { parseJson } from '@nx/devkit';

/**
 * Read-only access to the source repo. The source is never written: everything here uses
 * fs reads only.
 */

export function sourceExists(sourceDir: string, rel: string): boolean {
  return fs.existsSync(path.join(sourceDir, rel));
}

export function isSourceFile(sourceDir: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(sourceDir, rel)).isFile();
  } catch {
    return false;
  }
}

export function readSourceText(sourceDir: string, rel: string): string | undefined {
  return isSourceFile(sourceDir, rel)
    ? fs.readFileSync(path.join(sourceDir, rel), 'utf8')
    : undefined;
}

/** JSON with comments and trailing commas allowed (tsconfig.json and angular.json have both). */
export function readSourceJson<T extends object = Record<string, unknown>>(
  sourceDir: string,
  rel: string,
): T | undefined {
  const text = readSourceText(sourceDir, rel);
  if (text === undefined) return undefined;
  try {
    return parseJson<T>(text);
  } catch {
    return undefined;
  }
}

export type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  resolutions?: Record<string, unknown>;
  browserslist?: unknown;
};

export function readSourcePackageJson(sourceDir: string): PackageJson | undefined {
  return readSourceJson<PackageJson>(sourceDir, 'package.json');
}

export function sourceDependency(pkg: PackageJson | undefined, name: string): string | undefined {
  return pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name];
}

/** Parses JSON (comments and trailing commas allowed); a parse error names `label`. */
export function parseJsonStrict<T extends object = Record<string, unknown>>(
  text: string,
  label: string,
): T {
  try {
    return parseJson<T>(text);
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
    throw new Error(
      `migrate: could not parse ${label} (${reason}). Fix the JSON in the source (comments and ` +
        'trailing commas are fine) and run again.',
    );
  }
}

/** Like readSourceJson, but a file that exists and is not valid JSON is an error. */
export function readSourceJsonStrict<T extends object = Record<string, unknown>>(
  sourceDir: string,
  rel: string,
): T | undefined {
  const text = readSourceText(sourceDir, rel);
  return text === undefined ? undefined : parseJsonStrict<T>(text, rel);
}
