/**
 * Angular's application builder writes the browser files to `<base>/browser/` unless
 * `outputPath.browser` is "". pstack release builds never have a browser/ folder: the build
 * target of an application-builder app gets `outputPath: { base, browser: "" }`, and the release
 * build refuses anything else (see the build executor).
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Angular application builders (Angular 17+), as Nx and Angular name them. */
export const APPLICATION_BUILDER =
  /^(?:@angular\/build|@angular-devkit\/build-angular|@nx\/angular|@nrwl\/angular):application$/;

/**
 * Options of the application builder that make a server-rendered build (prerendering and an app
 * shell still produce static browser files, so they are not among them).
 */
export const SSR_OPTIONS = ['server', 'ssr'] as const;

/** Whether a target runs the application builder. */
export function isApplicationBuilder(target: unknown): boolean {
  return isObject(target) && typeof target['executor'] === 'string'
    ? APPLICATION_BUILDER.test(target['executor'])
    : false;
}

/** The SSR option a set of options turns on, if any. */
export function ssrOption(options: Json): string | undefined {
  if (options['outputMode'] === 'server') return 'outputMode';
  return SSR_OPTIONS.find((k) => options[k] !== undefined && options[k] !== false);
}

const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

export type FlatOutputChange = 'set' | 'flat' | 'ssr' | 'none';

/**
 * Makes an application-builder target's outputs flat: a string outputPath becomes
 * `{ base: <it>, browser: "" }`, an object gets `browser: ""` (other fields kept), in the options
 * and in every configuration that sets outputPath. 'ssr' (nothing changed) for server-rendered
 * builds, 'flat' when already flat, 'none' when the target is not an application builder.
 */
export function flattenApplicationOutput(target: unknown): FlatOutputChange {
  if (!isApplicationBuilder(target)) return 'none';
  const t = target as Json;
  const sets = [
    t['options'],
    ...Object.values(isObject(t['configurations']) ? t['configurations'] : {}),
  ].filter(isObject);
  if (sets.some((o) => ssrOption(o))) return 'ssr';
  let changed = false;
  for (const o of sets) {
    const out = o['outputPath'];
    if (typeof out === 'string') {
      o['outputPath'] = { base: out, browser: '' };
      changed = true;
    } else if (isObject(out) && out['browser'] !== '') {
      o['outputPath'] = { ...out, browser: '' };
      changed = true;
    }
  }
  return changed ? 'set' : 'flat';
}

/** `base` of an object outputPath, or the string itself. */
export function outputBase(outputPath: unknown): string | undefined {
  if (typeof outputPath === 'string') return outputPath;
  if (isObject(outputPath) && typeof outputPath['base'] === 'string') return outputPath['base'];
  return undefined;
}

/** Whether two output paths name the same folder (workspace-relative, separators ignored). */
export function sameOutput(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** The folder an outputPath serves from: base/<browser> (browser "" = base), or the string. */
export function servedOutput(outputPath: unknown): string | undefined {
  if (typeof outputPath === 'string') return outputPath;
  if (!isObject(outputPath) || typeof outputPath['base'] !== 'string') return undefined;
  const browser = outputPath['browser'] === undefined ? 'browser' : String(outputPath['browser']);
  return browser === '' ? outputPath['base'] : `${normalize(outputPath['base'])}/${browser}`;
}
