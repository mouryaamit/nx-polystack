import * as fs from 'fs';
import * as path from 'path';

/**
 * What a workspace's own build script (e.g. tools/scripts/build.js) does after `nx build`, read
 * from it and the scripts it runs, so the release target can do the same.
 */
export interface SourcePipeline {
  /** The script files read (workspace-relative), sorted. */
  scripts: string[];
  /** CSP nonce written into index.html; undefined when no step writes one. */
  nonce?: {
    placeholder?: string;
    tags?: 'all' | 'legacy';
    position?: 'end' | 'after-tag-name';
    replaceTokens: string[];
    addMeta: boolean;
  };
  /** HTML comments removed from index.html in every env. */
  stripHtmlComments: boolean;
  /** Comments removed from the built JS/CSS (UAT/PROD). */
  stripComments: boolean;
  /** The app's JS obfuscated (UAT/PROD), as the release executor's `obfuscate` profile. */
  obfuscate?: ObfuscateProfile;
  /** javascript-obfuscator options the script sets that differ from that preset. */
  obfuscateOptions?: Record<string, unknown>;
  /** Console calls removed from the built JS. */
  dropConsole: boolean;
  /** IANA time zone the build stamp is written in (from a `timeZone: '…'` option). */
  timezone?: string;
}

export type ObfuscateProfile = 'light' | 'medium' | 'strong';

/** What the release executor's presets set for the options read from a script (see hardening/obfuscate.ts). */
const PRESET_VALUES: Record<'light' | 'medium', Record<string, unknown>> = {
  light: {
    stringArrayThreshold: 0.5,
    identifierNamesGenerator: 'mangled',
    stringArrayWrappersCount: 0,
  },
  medium: {
    stringArrayThreshold: 0.75,
    identifierNamesGenerator: 'hexadecimal',
    stringArrayWrappersCount: 1,
  },
};

/** `key: value` (number, quoted string or boolean) in a block of javascript-obfuscator options. */
function optionValue(block: string, key: string): unknown {
  const m = new RegExp(`\\b${key}\\s*:\\s*(?:(['"\`])([\\w-]+)\\1|([\\d.]+)|(true|false))`).exec(
    block,
  );
  if (!m) return undefined;
  if (m[2] !== undefined) return m[2];
  if (m[3] !== undefined) return Number(m[3]);
  return m[4] === 'true';
}

/**
 * The preset and overrides matching an obfuscate script: its shared options plus the profile it
 * runs by default (`process.env.X || 'light'` picking a `light: { … }` block). Hexadecimal names
 * map to medium, anything else to light; the options that then differ become overrides.
 */
function obfuscateSettings(text: string): Pick<SourcePipeline, 'obfuscate' | 'obfuscateOptions'> {
  const named = /\bprocess\.env\.\w*PROFILE\w*\s*(?:\|\||\?\?)\s*['"`](\w+)['"`]/.exec(text)?.[1];
  if (named === 'medium' || named === 'strong') return { obfuscate: named };
  const profileBlock = named
    ? new RegExp(`\\b${named}\\s*:\\s*\\{([^}]*)\\}`).exec(text)?.[1] ?? ''
    : '';
  const read = (key: string) => optionValue(profileBlock, key) ?? optionValue(text, key);
  const names = read('identifierNamesGenerator');
  const preset = names === 'hexadecimal' ? 'medium' : 'light';
  const overrides: Record<string, unknown> = {};
  for (const [key, presetValue] of Object.entries(PRESET_VALUES[preset])) {
    const value = read(key);
    if (value !== undefined && value !== presetValue) overrides[key] = value;
  }
  return Object.keys(overrides).length > 0
    ? { obfuscate: preset, obfuscateOptions: overrides }
    : { obfuscate: preset };
}

const read = (root: string, rel: string): string | undefined => {
  try {
    return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  } catch {
    return undefined;
  }
};

/** `node <dir>/<x>.js` calls in a script's text, as workspace-relative paths. */
function calledScripts(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bnode\s+(['"]?)([\w./-]+\.(?:c|m)?js)\1/g)) {
    out.add(path.posix.normalize(m[2].replace(/^\.\//, '')));
  }
  // `run(\`node tools/scripts/x.js …\`)` is the common form; plain requires are helpers, not steps.
  return [...out].sort();
}

/** The nonce settings of a script that puts a nonce placeholder on index.html tags. */
function nonceOf(text: string): SourcePipeline['nonce'] | undefined {
  if (!/\bnonce\b/i.test(text) || !/<script/i.test(text)) return undefined;
  const placeholder = /\bconst\s+NONCE\s*=\s*(['"`])((?:(?!\1).)*)\1/.exec(text)?.[2];
  // Inline scripts only: the <script pattern skips tags with src.
  const tags = /<script\(\?!\[\^>\]\*\\bsrc=\)/.test(text) ? 'legacy' : undefined;
  const position = /`<(?:script|link|style) nonce=/.test(text) ? 'after-tag-name' : undefined;
  const replaceTokens = [
    ...new Set(
      [...text.matchAll(/\.replace\(\/([A-Za-z0-9_-]{4,})\/g,\s*NONCE\)/g)].map((m) => m[1]),
    ),
  ].sort();
  const addMeta = /property=\\?["']csp-nonce/.test(text);
  return { placeholder, tags, position, replaceTokens, addMeta };
}

/** Reads the custom build scripts and the step scripts they run. */
export function readSourcePipeline(root: string, buildScripts: string[]): SourcePipeline {
  const pipeline: SourcePipeline = {
    scripts: [],
    stripHtmlComments: false,
    stripComments: false,
    dropConsole: false,
  };
  const seen = new Set<string>();
  const visit = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = read(root, rel);
    if (text === undefined) return;
    pipeline.scripts.push(rel);
    const name = path.posix.basename(rel);
    const nonce = nonceOf(text);
    if (nonce && !pipeline.nonce) pipeline.nonce = nonce;
    if (nonce && /<!--\(\?!#\)/.test(text)) pipeline.stripHtmlComments = true;
    if (/obfuscat/i.test(name) && !pipeline.obfuscate)
      Object.assign(pipeline, obfuscateSettings(text));
    if (/strip-?comments/i.test(name)) pipeline.stripComments = true;
    if (/drop_console|pure_funcs|dropConsole/.test(text)) pipeline.dropConsole = true;
    const tz = /\btimeZone\s*:\s*['"`]([A-Za-z_]+\/[A-Za-z_+-]+)['"`]/.exec(text)?.[1];
    if (tz && !pipeline.timezone) pipeline.timezone = tz;
    for (const called of calledScripts(text)) visit(called);
    // Local helpers it requires (build-info, timestamp, …): read for the stamp time zone.
    for (const m of text.matchAll(/\brequire\(\s*['"](\.{1,2}\/[\w./-]+)['"]\s*\)/g)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      visit(/\.(c|m)?js$/.test(dep) ? dep : `${dep}.js`);
    }
  };
  for (const s of buildScripts) visit(s);
  pipeline.scripts.sort();
  return pipeline;
}
