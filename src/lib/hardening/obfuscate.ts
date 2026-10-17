import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { listFiles } from './files';
import { ObfuscateMode } from './options';
import { isModuleCode } from './strip';

/** The part of javascript-obfuscator's API this step uses. */
export interface Obfuscator {
  obfuscate(code: string, options: object): { getObfuscatedCode(): string };
}

export interface ObfuscateOptions {
  /** Workspace root: javascript-obfuscator is loaded from its node_modules. */
  repoRoot: string;
  mode: ObfuscateMode;
  /** Overrides on top of the preset (validated by checkObfuscateOptions). */
  overrides?: Record<string, unknown>;
  /** Test seam; loaded from the workspace when absent. */
  obfuscator?: Obfuscator;
}

export interface ObfuscateResult {
  files: number;
  bytesBefore: number;
  bytesAfter: number;
}

/** A string only the env-secret runtime holds (the aes-gcm HKDF info prefix). */
export const DECRYPT_MARKER = 'pstack-env-v2|';

const SKIP_DIRS = ['assets'];
/**
 * Chunks left alone: webpack `name.js` / `name.<hash>.js`, esbuild `name-<HASH>.js`. Vendor code
 * and the webpack runtime gain nothing from obfuscation and the runtime holds the SRI hashes.
 */
const SKIPPED_CHUNK =
  /^(?:runtime|polyfills|vendor|scripts|styles)(?:\.[a-z0-9]+|-[A-Z0-9]+)?\.m?js$/;

export function isSkippedChunk(fileName: string): boolean {
  return SKIPPED_CHUNK.test(fileName);
}

/** Options every preset shares; never overridable (CSP-safe, chunks keep finding each other). */
const FIXED: Record<string, unknown> = {
  compact: true,
  renameGlobals: false,
  renameProperties: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  sourceMap: false,
  target: 'browser-no-eval',
};

/**
 * Presets, measured on a 2.8 MB Angular chunk (gzip growth): light ≈ +20% (short names, half the
 * strings in a rotated, shuffled array, no wrappers), medium ≈ +67% (hexadecimal names, three
 * quarters of the strings, wrappers), strong = medium plus, for the chunk holding the decrypt
 * code, rc4 string encoding and light control-flow flattening (≈ +210% on that chunk).
 */
const PRESETS: Record<'light' | 'medium', Record<string, unknown>> = {
  light: {
    stringArray: true,
    stringArrayThreshold: 0.5,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayEncoding: [],
    stringArrayWrappersCount: 0,
    identifierNamesGenerator: 'mangled',
    transformObjectKeys: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    unicodeEscapeSequence: false,
  },
  medium: {
    stringArray: true,
    stringArrayThreshold: 0.75,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayEncoding: [],
    identifierNamesGenerator: 'hexadecimal',
    transformObjectKeys: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    unicodeEscapeSequence: false,
  },
};
const STRONG_DECRYPT = {
  stringArrayEncoding: ['rc4'],
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.1,
};

/**
 * javascript-obfuscator options for one file: the preset, the app's overrides, then the fixed
 * CSP-safe settings. strong adds rc4 and control-flow flattening to the chunk holding the decrypt
 * code (before the overrides, so they can still tune it).
 */
export function obfuscatorOptions(
  mode: Exclude<ObfuscateMode, 'off'>,
  kind: 'base' | 'decrypt',
  module: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...PRESETS[mode === 'strong' ? 'medium' : mode],
    ...(mode === 'strong' && kind === 'decrypt' ? STRONG_DECRYPT : {}),
    ...overrides,
    ...FIXED,
    sourceType: module ? 'module' : 'script',
  };
}

/**
 * Obfuscates main and the lazy chunks under the served root (assets/ and the skipped chunks
 * untouched). The obfuscator is only loaded when there is a file to process.
 */
export async function obfuscateOutput(
  served: string,
  o: ObfuscateOptions,
): Promise<ObfuscateResult> {
  const result: ObfuscateResult = { files: 0, bytesBefore: 0, bytesAfter: 0 };
  if (o.mode === 'off') return result;

  const root = path.resolve(served);
  const files = listFiles(root, ['js', 'mjs'], { skipDirs: SKIP_DIRS }).filter(
    (f) => !isSkippedChunk(path.basename(f)),
  );
  if (files.length === 0) return result;

  const obfuscator = o.obfuscator ?? loadObfuscator(o.repoRoot);
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const out = obfuscateFile(obfuscator, code, file, root, o.mode, o.overrides ?? {});
    result.bytesBefore += Buffer.byteLength(code);
    result.bytesAfter += Buffer.byteLength(out);
    if (out !== code) {
      fs.writeFileSync(file, out);
      result.files++;
    }
  }
  return result;
}

/** A file guessed to be an ES module that does not parse as one is tried once more as a script. */
function obfuscateFile(
  obfuscator: Obfuscator,
  code: string,
  file: string,
  root: string,
  mode: Exclude<ObfuscateMode, 'off'>,
  overrides: Record<string, unknown>,
): string {
  const kind = code.includes(DECRYPT_MARKER) ? 'decrypt' : 'base';
  const module = isModuleCode(file, code, root);
  // Classic-script chunks share window: a per-file prefix keeps their string-array helpers apart;
  // a seed from the content makes the output reproducible.
  const digest = createHash('sha1')
    .update(path.relative(root, file))
    .update('\0')
    .update(code)
    .digest('hex');
  const perFile = {
    identifiersPrefix: `_p${digest.slice(0, 6)}`,
    seed: parseInt(digest.slice(6, 14), 16),
  };
  const attempts = module ? [true, false] : [false];
  let firstError: Error | undefined;
  for (const asModule of attempts) {
    try {
      return obfuscator
        .obfuscate(code, { ...obfuscatorOptions(mode, kind, asModule, overrides), ...perFile })
        .getObfuscatedCode();
    } catch (err) {
      firstError ??= err as Error;
    }
  }
  throw new Error(`obfuscate: ${path.relative(root, file)}: ${firstError?.message}`);
}

export function loadObfuscator(repoRoot: string): Obfuscator {
  let resolved: string;
  try {
    resolved = require.resolve('javascript-obfuscator', { paths: [repoRoot] });
  } catch {
    throw new Error(
      'obfuscate: add javascript-obfuscator to devDependencies (npm i -D javascript-obfuscator@4)',
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(resolved) as Obfuscator;
}
