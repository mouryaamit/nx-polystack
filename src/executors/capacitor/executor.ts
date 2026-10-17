import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import { CapacitorExecutorSchema } from './schema.d';

export type Runner = (cmd: string, opts: ExecSyncOptions) => void;

const defaultRunner: Runner = (cmd, opts) => {
  console.log(`▶ ${cmd}`);
  execSync(cmd, opts);
};

const COMMANDS = ['sync', 'open', 'add', 'copy'];
const PLATFORMS = ['android', 'ios'];
/** Commands that copy the web build into the native project. */
const NEEDS_WEB_BUILD = ['sync', 'copy'];

export default async function capacitorExecutor(
  options: CapacitorExecutorSchema,
  context: ExecutorContext,
  runner: Runner = defaultRunner,
): Promise<{ success: boolean }> {
  const { command, platform } = options;
  const project = context.projectName as string;

  if (!COMMANDS.includes(command)) {
    throw new Error(
      `capacitor executor: command must be one of ${COMMANDS.join(', ')} (got "${command}").`,
    );
  }
  if (!PLATFORMS.includes(platform)) {
    throw new Error(
      `capacitor executor: platform must be android or ios (got "${platform}"). ` +
        `Example: nx run ${project}:cap-sync --platform=android`,
    );
  }

  const appRoot =
    context.projectsConfigurations?.projects?.[project]?.root ?? path.join('apps', project);
  const appDir = path.join(context.root, appRoot);

  if (!fs.existsSync(path.join(appDir, 'package.json'))) {
    throw new Error(
      `capacitor executor: ${appRoot}/package.json not found — it lists the Capacitor packages.`,
    );
  }

  const webDir = options.webDir ?? path.join('dist', 'apps', project);
  if (NEEDS_WEB_BUILD.includes(command) && !fs.existsSync(path.join(context.root, webDir))) {
    throw new Error(
      `capacitor executor: web build not found at ${webDir}. ` +
        `Build it first, e.g. nx run ${project}:release:prod`,
    );
  }

  const opts: ExecSyncOptions = { stdio: 'inherit', cwd: appDir };
  // Install the app's own packages when the Capacitor CLI isn't there yet.
  if (!fs.existsSync(path.join(appDir, 'node_modules', '@capacitor', 'cli'))) {
    runner('npm install', opts);
  }
  // --no-install: never fetch an unrelated "cap" package from the registry.
  runner(`npx --no-install cap ${command} ${platform}`, opts);
  return { success: true };
}
