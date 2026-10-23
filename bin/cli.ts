// pstack — @mouryaamit/nx-polystack CLI. Run `pstack --help` for usage.

import * as path from 'path';

import { flagBoolean, parseArgs } from '../src/cli/args';
import { COMMANDS } from '../src/cli/commands';
import {
  findWorkspaceRoot,
  readPackageVersion,
  resolveLocalPlugin,
  selfPackageRoot,
} from '../src/cli/context';
import { helpText } from '../src/cli/help';
import {
  assertLocalSupports,
  delegate,
  delegationArgs,
  shouldDelegate,
  upgradeHint,
  WORKSPACE_COMMANDS,
  workspaceNxProblem,
} from '../src/cli/launcher';
import { CliError, CommandContext } from '../src/cli/types';

async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);
  const selfRoot = selfPackageRoot(__dirname);
  const selfVersion = readPackageVersion(path.join(selfRoot, 'package.json'));
  const cwd = process.cwd();
  const wsRoot = findWorkspaceRoot(cwd);
  const local = wsRoot ? resolveLocalPlugin(wsRoot) : null;

  if (flags['v'] || flags['version']) {
    console.log(selfVersion);
    if (local && local.root !== selfRoot && local.version !== selfVersion) {
      console.log(`workspace plugin: ${local.version}`);
    }
    return 0;
  }

  if (!command || command === 'help' || flags['h'] || flags['help']) {
    console.log(helpText(selfVersion));
    return 0;
  }

  const nxProblem = wsRoot ? workspaceNxProblem(command, wsRoot) : null;
  if (nxProblem) {
    console.error(`\nError: ${nxProblem}`);
    return 1;
  }

  if (local && wsRoot && shouldDelegate({ command, flags, env: process.env, selfRoot, local })) {
    try {
      assertLocalSupports(command, local.version, flags);
    } catch (err: unknown) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const hint = upgradeHint(local.version, selfVersion);
    if (hint) console.error(hint);
    // Older local CLIs only look for nx.json in their cwd, so app/env/lib/llm run from the workspace root.
    const delegateCwd = WORKSPACE_COMMANDS.has(command) ? wsRoot : cwd;
    return delegate(local.cliPath, delegationArgs(command, argv, cwd, delegateCwd), delegateCwd);
  }

  if (wsRoot && !local && WORKSPACE_COMMANDS.has(command)) {
    console.error(
      'pstack: this workspace does not have @mouryaamit/nx-polystack installed; ' +
        `using global v${selfVersion}.`,
    );
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(
      `Unknown command: "${command}"\n\nRun "pstack --help" to see available commands.`,
    );
    return 1;
  }

  let verbose: boolean;
  let dryRun: boolean;
  try {
    verbose = flagBoolean(flags, 'verbose');
    dryRun = !!flags['d'] || flagBoolean(flags, 'dryRun');
  } catch (err: unknown) {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const ctx: CommandContext = {
    cwd,
    positionals,
    flags,
    dryRun,
    verbose,
    selfVersion,
    selfRoot,
  };

  try {
    return await handler(ctx);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nError: ${message}`);
    if (verbose && !(err instanceof CliError) && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
