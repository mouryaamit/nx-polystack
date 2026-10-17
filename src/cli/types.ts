import type { Flags } from './args';

export interface CommandContext {
  /** Directory pstack was invoked from. */
  cwd: string;
  /** Non-flag arguments after the command name. */
  positionals: string[];
  flags: Flags;
  dryRun: boolean;
  verbose: boolean;
  /** Version of the running pstack package. */
  selfVersion: string;
  /** Root directory (contains package.json) of the running pstack package. */
  selfRoot: string;
}

/** An expected, user-facing failure. Printed as "Error: <message>" without a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
