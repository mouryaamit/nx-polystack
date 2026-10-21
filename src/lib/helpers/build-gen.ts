import * as fs from 'fs';
import * as path from 'path';

import { readPackageVersion, selfPackageRoot } from '../../cli/context';

/**
 * Which tool made a build, written into the build meta payload (`<meta name="x-build">`):
 * `gen` = "nx-polystack@<version>", plus the Angular (`ng`) and Nx (`nx`) versions installed in the
 * workspace. Lets `pstack inspect` tell a pstack build, and its versions, from the output alone.
 */
export interface GenInfo {
  gen: string;
  ng?: string;
  nx?: string;
}

export const GEN_PREFIX = 'nx-polystack@';

/** Release option `buildMeta`. */
export interface BuildMetaOptions {
  /** Write gen/ng/nx into the build meta (default true). */
  gen?: boolean;
}

function installedVersion(repoRoot: string, pkg: string): string | undefined {
  const file = path.join(repoRoot, 'node_modules', pkg, 'package.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    return readPackageVersion(file);
  } catch {
    return undefined;
  }
}

export function pluginOwnVersion(): string {
  return readPackageVersion(path.join(selfPackageRoot(__dirname), 'package.json'));
}

/** gen/ng/nx for the meta payload, or undefined when `buildMeta.gen` is false. */
export function generatorInfo(
  repoRoot: string,
  options: BuildMetaOptions | undefined,
  version: string = pluginOwnVersion(),
): GenInfo | undefined {
  if (options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
    throw new Error('buildMeta must be an object, e.g. { "gen": false }');
  }
  if (options?.gen !== undefined && typeof options.gen !== 'boolean') {
    throw new Error('buildMeta.gen must be true or false');
  }
  if (options?.gen === false) return undefined;
  const info: GenInfo = { gen: `${GEN_PREFIX}${version}` };
  const ng = installedVersion(repoRoot, '@angular/core');
  const nx = installedVersion(repoRoot, 'nx');
  if (ng) info.ng = ng;
  if (nx) info.nx = nx;
  return info;
}

export interface FoundMeta {
  /** The meta tag name (x-build, or a renamed one). */
  name: string;
  payload: Record<string, unknown>;
}

/** Fields every pstack build meta has; a base64 JSON meta with them is one, whatever its name. */
const REQUIRED = ['env', 'timestamp_utc', 'commit'];

/** Every `<meta name=… content=…>` whose content is a pstack build payload. */
export function findBuildMeta(html: string): FoundMeta[] {
  const out: FoundMeta[] = [];
  const tagRe = /<meta\b[^>]*>/gi;
  for (const [tag] of html.matchAll(tagRe)) {
    const name = /\bname\s*=\s*(["'])([^"']*)\1/i.exec(tag)?.[2];
    const content = /\bcontent\s*=\s*(["'])([^"']*)\1/i.exec(tag)?.[2];
    if (!name || !content || !/^[A-Za-z0-9+/=_-]+$/.test(content)) continue;
    try {
      const json = JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
      if (json && typeof json === 'object' && REQUIRED.every((k) => k in json)) {
        out.push({ name, payload: json });
      }
    } catch {
      // not a build meta
    }
  }
  return out;
}
