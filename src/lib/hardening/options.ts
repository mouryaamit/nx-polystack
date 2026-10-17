export type CheckMode = 'fail' | 'warn' | 'off';

export const CHECK_MODES: readonly CheckMode[] = ['fail', 'warn', 'off'];

export type ObfuscateMode = 'off' | 'light' | 'medium' | 'strong';

export const OBFUSCATE_MODES: readonly ObfuscateMode[] = ['off', 'light', 'medium', 'strong'];

/**
 * javascript-obfuscator options an app may override on top of its preset, with their checks.
 * Anything that needs eval/Function, locks domains, renames globals or properties, or changes the
 * output target is not in the list.
 */
const unit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
const bool = (v: unknown) => typeof v === 'boolean';
const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10;
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
export const OBFUSCATE_OVERRIDES: Readonly<Record<string, [(v: unknown) => boolean, string]>> = {
  stringArray: [bool, 'true or false'],
  stringArrayThreshold: [unit, 'a number from 0 to 1'],
  stringArrayRotate: [bool, 'true or false'],
  stringArrayShuffle: [bool, 'true or false'],
  stringArrayEncoding: [
    (v) => Array.isArray(v) && v.every((e) => ['none', 'base64', 'rc4'].includes(e as string)),
    'a list of none, base64, rc4',
  ],
  stringArrayIndexShift: [bool, 'true or false'],
  stringArrayWrappersCount: [count, 'a whole number from 0 to 10'],
  stringArrayWrappersType: [(v) => v === 'variable' || v === 'function', 'variable or function'],
  stringArrayWrappersChainedCalls: [bool, 'true or false'],
  identifierNamesGenerator: [
    (v) => ['hexadecimal', 'mangled', 'mangled-shuffled'].includes(v as string),
    'hexadecimal, mangled or mangled-shuffled',
  ],
  controlFlowFlattening: [bool, 'true or false'],
  controlFlowFlatteningThreshold: [unit, 'a number from 0 to 1'],
  deadCodeInjection: [bool, 'true or false'],
  deadCodeInjectionThreshold: [unit, 'a number from 0 to 1'],
  numbersToExpressions: [bool, 'true or false'],
  simplify: [bool, 'true or false'],
  splitStrings: [bool, 'true or false'],
  splitStringsChunkLength: [(v) => Number.isInteger(v) && (v as number) >= 1, 'a whole number ≥ 1'],
  transformObjectKeys: [bool, 'true or false'],
  unicodeEscapeSequence: [bool, 'true or false'],
  reservedNames: [strings, 'a list of strings (regular expressions)'],
  reservedStrings: [strings, 'a list of strings (regular expressions)'],
};
export const CONSOLE_METHODS = ['log', 'debug', 'warn', 'info', 'error', 'trace'] as const;
export const DEFAULT_DROP_CONSOLE = ['log', 'debug', 'warn'];

const HARDEN_WARNING =
  'harden is replaced by stripComments and dropConsole (and leakCheck, sourceMaps); set those instead';

/** Release-target options that drive the post-build hardening steps. */
export interface HardeningOptions {
  leakCheck?: CheckMode;
  sourceMaps?: CheckMode;
  stripComments?: boolean;
  dropConsole?: string[];
  /** Obfuscate the app's own JS (main and lazy chunks). */
  obfuscate?: ObfuscateMode;
  /** javascript-obfuscator overrides on top of the preset (OBFUSCATE_OVERRIDES keys only). */
  obfuscateOptions?: Record<string, unknown>;
  /** Deprecated: read as stripComments + the default dropConsole when those are unset. */
  harden?: boolean;
}

export interface ResolvedHardening {
  leakCheck: CheckMode;
  sourceMaps: CheckMode;
  stripComments: boolean;
  dropConsole: string[];
  obfuscate: ObfuscateMode;
  obfuscateOptions: Record<string, unknown>;
  warnings: string[];
}

/**
 * Effective hardening settings for one build. DEV turns every step off; absent options are off;
 * the LEAK_CHECK environment variable overrides leakCheck for one run.
 */
export function resolveHardening(
  o: HardeningOptions,
  env: string,
  vars: Record<string, string | undefined> = process.env,
): ResolvedHardening {
  if (env === 'DEV') {
    return {
      leakCheck: 'off',
      sourceMaps: 'off',
      stripComments: false,
      dropConsole: [],
      obfuscate: 'off',
      obfuscateOptions: {},
      warnings: [],
    };
  }

  const warnings: string[] = [];
  let stripComments = o.stripComments;
  let dropConsole = o.dropConsole;
  if (o.harden) {
    warnings.push(HARDEN_WARNING);
    stripComments ??= true;
    dropConsole ??= DEFAULT_DROP_CONSOLE;
  }

  return {
    leakCheck: leakCheckOverride(vars.LEAK_CHECK) ?? checkMode('leakCheck', o.leakCheck),
    sourceMaps: checkMode('sourceMaps', o.sourceMaps),
    stripComments: stripComments ?? false,
    dropConsole: consoleMethods(dropConsole ?? []),
    obfuscate: obfuscateMode(o.obfuscate),
    obfuscateOptions: checkObfuscateOptions(o.obfuscateOptions),
    warnings,
  };
}

function checkMode(option: string, value: string | undefined): CheckMode {
  if (value === undefined) return 'off';
  if (!isCheckMode(value)) {
    throw new Error(`${option} must be one of ${CHECK_MODES.join(', ')} (got "${value}")`);
  }
  return value;
}

function obfuscateMode(value: string | undefined): ObfuscateMode {
  if (value === undefined) return 'off';
  if (!(OBFUSCATE_MODES as readonly string[]).includes(value)) {
    throw new Error(`obfuscate must be one of ${OBFUSCATE_MODES.join(', ')} (got "${value}")`);
  }
  return value as ObfuscateMode;
}

/** Throws on a key outside OBFUSCATE_OVERRIDES or a value of the wrong kind. */
export function checkObfuscateOptions(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('obfuscateOptions must be an object of javascript-obfuscator options');
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const rule = OBFUSCATE_OVERRIDES[key];
    if (!rule) {
      throw new Error(
        `obfuscateOptions.${key} cannot be set (allowed: ${Object.keys(OBFUSCATE_OVERRIDES).join(
          ', ',
        )})`,
      );
    }
    if (!rule[0](v)) throw new Error(`obfuscateOptions.${key} must be ${rule[1]}`);
    out[key] = v;
  }
  return out;
}

function leakCheckOverride(raw: string | undefined): CheckMode | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (!isCheckMode(value)) {
    throw new Error(`LEAK_CHECK must be one of ${CHECK_MODES.join(', ')}`);
  }
  return value;
}

function consoleMethods(methods: string[]): string[] {
  if (!Array.isArray(methods)) {
    throw new Error(
      `dropConsole must be a list of console methods (e.g. ["log", "debug", "warn"])`,
    );
  }
  const allowed: readonly string[] = CONSOLE_METHODS;
  const unknown = methods.filter((m) => !allowed.includes(m));
  if (unknown.length) {
    const list = allowed.join(', ');
    throw new Error(
      `dropConsole: unknown console method(s) ${unknown.join(', ')}; allowed: ${list}`,
    );
  }
  return [...new Set(methods)];
}

function isCheckMode(value: string): value is CheckMode {
  return (CHECK_MODES as readonly string[]).includes(value);
}
