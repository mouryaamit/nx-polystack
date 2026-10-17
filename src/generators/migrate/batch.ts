import * as fs from 'fs';
import * as path from 'path';

import { ADAPTER_IDS, parseMinConfidence } from './adapters';
import { NAME_RE, parseDir } from './names';
import type { MigrateGeneratorSchema } from './schema.d';

export interface BatchDefaults {
  forceAngular?: boolean;
  maxFiles?: number;
  minConfidence?: number;
  dir?: string;
  rewriteImports?: boolean;
}

export interface BatchEntry extends BatchDefaults {
  /** 1-based position in the file. */
  index: number;
  /** `source` as written in the file. */
  given: string;
  /** `source` resolved against the file's folder. */
  source: string;
  name?: string;
  adapter?: MigrateGeneratorSchema['adapter'];
  projects?: string[];
  noDeps?: boolean;
  prefix?: string;
}

export interface BatchFile {
  defaults: BatchDefaults;
  entries: BatchEntry[];
}

const TOP_KEYS = ['defaults', 'migrations'];
const DEFAULT_KEYS = ['forceAngular', 'maxFiles', 'minConfidence', 'dir', 'rewriteImports'];
const ENTRY_KEYS = [
  'source',
  'name',
  'adapter',
  'projects',
  'noDeps',
  'prefix',
  'forceAngular',
  'maxFiles',
  'minConfidence',
  'dir',
  'rewriteImports',
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkKeys(obj: Record<string, unknown>, allowed: string[], fail: (m: string) => never) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`unknown key "${k}"`);
}

function readDefaults(obj: Record<string, unknown>, fail: (m: string) => never): BatchDefaults {
  const out: BatchDefaults = {};
  if (obj['forceAngular'] !== undefined) {
    if (typeof obj['forceAngular'] !== 'boolean') fail('"forceAngular" must be true or false');
    out.forceAngular = obj['forceAngular'] as boolean;
  }
  if (obj['rewriteImports'] !== undefined) {
    if (typeof obj['rewriteImports'] !== 'boolean') fail('"rewriteImports" must be true or false');
    out.rewriteImports = obj['rewriteImports'] as boolean;
  }
  if (obj['maxFiles'] !== undefined) {
    const n = obj['maxFiles'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      fail('"maxFiles" must be a positive whole number');
    }
    out.maxFiles = n as number;
  }
  if (obj['minConfidence'] !== undefined) {
    if (typeof obj['minConfidence'] !== 'number') {
      fail('"minConfidence" must be a number from 0.50 to 1.00');
    }
    try {
      out.minConfidence = parseMinConfidence(obj['minConfidence']);
    } catch {
      fail('"minConfidence" must be a number from 0.50 to 1.00');
    }
  }
  if (obj['dir'] !== undefined) {
    try {
      out.dir = parseDir(typeof obj['dir'] === 'string' ? obj['dir'] : String(obj['dir']));
    } catch {
      fail('"dir" must be kebab-case folder names separated by "/"');
    }
    if (typeof obj['dir'] !== 'string')
      fail('"dir" must be kebab-case folder names separated by "/"');
  }
  return out;
}

/** The batch file, validated, with each `source` resolved against the file's folder. */
export function readBatchFile(
  file: string,
  adapterIds: readonly string[] = ADAPTER_IDS,
): BatchFile {
  const where = `migrate --config: ${file}`;
  const failFile = (m: string): never => {
    throw new Error(`${where}: ${m}`);
  };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return failFile('cannot read the file');
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    return failFile(`is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isObject(data)) return failFile('must be a JSON object');
  checkKeys(data, TOP_KEYS, failFile);
  const list = data['migrations'];
  if (!Array.isArray(list) || list.length === 0) {
    return failFile('"migrations" must be a non-empty array');
  }
  let defaults: BatchDefaults = {};
  if (data['defaults'] !== undefined) {
    const d = data['defaults'];
    const failDefaults = (m: string): never => failFile(`"defaults": ${m}`);
    if (!isObject(d)) return failDefaults('must be an object');
    checkKeys(d, DEFAULT_KEYS, failDefaults);
    defaults = readDefaults(d, failDefaults);
  }

  const base = path.dirname(path.resolve(file));
  const names = new Map<string, number>();
  const entries = list.map((raw, i): BatchEntry => {
    const index = i + 1;
    const label = () =>
      isObject(raw) && typeof raw['source'] === 'string'
        ? `entry ${index} (${raw['source']})`
        : `entry ${index}`;
    const fail = (m: string): never => failFile(`${label()}: ${m}`);
    if (!isObject(raw)) return fail('must be an object');
    checkKeys(raw, ENTRY_KEYS, fail);
    if (typeof raw['source'] !== 'string' || raw['source'].trim() === '') {
      return fail('"source" is required');
    }
    const given = raw['source'];
    const entry: BatchEntry = {
      index,
      given,
      source: path.isAbsolute(given) ? given : path.resolve(base, given),
      ...readDefaults(raw, fail),
    };
    for (const key of ['name', 'prefix'] as const) {
      const v = raw[key];
      if (v !== undefined) {
        if (typeof v !== 'string' || !NAME_RE.test(v)) {
          fail(`"${key}" must be kebab-case (lowercase letters, digits and single hyphens)`);
        }
        entry[key] = v as string;
      }
    }
    if (raw['adapter'] !== undefined) {
      if (!adapterIds.includes(raw['adapter'] as string)) {
        fail(`"adapter" must be one of ${adapterIds.join(', ')}`);
      }
      entry.adapter = raw['adapter'] as BatchEntry['adapter'];
    }
    if (raw['noDeps'] !== undefined) {
      if (typeof raw['noDeps'] !== 'boolean') fail('"noDeps" must be true or false');
      entry.noDeps = raw['noDeps'] as boolean;
    }
    const projects = raw['projects'];
    if (projects !== undefined) {
      const list =
        typeof projects === 'string'
          ? projects
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean)
          : Array.isArray(projects) && projects.every((p) => typeof p === 'string')
          ? (projects as string[]).map((p) => p.trim()).filter(Boolean)
          : fail('"projects" must be a list of names or a comma-separated string');
      if (list.length === 0) fail('"projects" must name at least one project');
      entry.projects = list;
    }
    if (entry.name) {
      const first = names.get(entry.name);
      if (first !== undefined) fail(`name "${entry.name}" is already used by entry ${first}`);
      names.set(entry.name, index);
    }
    return entry;
  });
  return { defaults, entries };
}

/** Options for one entry: command line < file defaults < entry. */
export function mergeEntryOptions(
  entry: BatchEntry,
  defaults: BatchDefaults,
  cli: BatchDefaults,
): MigrateGeneratorSchema {
  const out: MigrateGeneratorSchema = { source: entry.source, sourceLabel: entry.given };
  const forceAngular = entry.forceAngular ?? defaults.forceAngular ?? cli.forceAngular;
  const maxFiles = entry.maxFiles ?? defaults.maxFiles ?? cli.maxFiles;
  // --adapter skips detection: an inherited threshold does not apply (one set on the entry is refused).
  const minConfidence =
    entry.minConfidence ??
    (entry.adapter ? undefined : defaults.minConfidence ?? cli.minConfidence);
  if (entry.name !== undefined) out.name = entry.name;
  if (entry.adapter !== undefined) out.adapter = entry.adapter;
  if (entry.projects !== undefined) out.projects = entry.projects;
  if (entry.noDeps !== undefined) out.noDeps = entry.noDeps;
  if (entry.prefix !== undefined) out.prefix = entry.prefix;
  if (forceAngular !== undefined) out.forceAngular = forceAngular;
  if (maxFiles !== undefined) out.maxFiles = maxFiles;
  if (minConfidence !== undefined) out.minConfidence = minConfidence;
  const rewriteImports = entry.rewriteImports ?? defaults.rewriteImports ?? cli.rewriteImports;
  if (rewriteImports !== undefined) out.rewriteImports = rewriteImports;
  const dir = entry.dir ?? defaults.dir ?? cli.dir;
  if (dir !== undefined) {
    out.dir = dir;
    // Workspace adapters ignore an inherited dir (one set on the entry is refused).
    if (entry.dir === undefined) out.dirInherited = true;
  }
  return out;
}
