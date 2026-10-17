import { CliError } from './types';

export interface Flags {
  [key: string]: string | boolean;
}

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Flags;
}

export function toCamelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Parse CLI args. `args` is process.argv.slice(2). */
export function parseArgs(args: string[]): ParsedArgs {
  const flags: Flags = {};
  const positionals: string[] = [];
  let command = '';

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[toCamelCase(arg.slice(2, eqIdx))] = arg.slice(eqIdx + 1);
      } else {
        flags[toCamelCase(arg.slice(2))] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      flags[arg.slice(1)] = true;
    } else if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

const TRUE_VALUES = new Set(['', 'true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/** --flag-name for a camelCased key. */
function flagName(key: string): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * A boolean flag: bare `--x` or `--x=true|1|yes|on` is true; missing or `--x=false|0|no|off` is
 * false; any other value is a usage error.
 */
export function flagBoolean(flags: Flags, key: string): boolean {
  const v = flags[key];
  if (v === undefined || v === false) return false;
  if (v === true) return true;
  const s = v.trim().toLowerCase();
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  throw new CliError(`${flagName(key)} must be true or false (got "${v}").`);
}

/** A flag's value only when given as --key=value. */
export function flagString(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}
