import { execSync, ExecSyncOptions } from 'child_process';

import { ExecutorContext } from '@nx/devkit';

import { FlutterExportExecutorSchema } from './schema.d';

export type Runner = (cmd: string, opts: ExecSyncOptions) => void;

const defaultRunner: Runner = (cmd, opts) => {
  console.log(`▶ ${cmd}`);
  execSync(cmd, opts);
};

export default async function flutterExportExecutor(
  options: FlutterExportExecutorSchema,
  context: ExecutorContext,
  runner: Runner = defaultRunner,
): Promise<{ success: boolean }> {
  const { flutterfowProject, dest, branch, flutterfowEnv = 'Production' } = options;
  const repoRoot = context.root;

  const parts = [
    'npx',
    'dotenv',
    '-e',
    '.env',
    '--',
    'flutterflow',
    'export-code',
    '--project',
    flutterfowProject,
    '--no-parent-folder',
    '-d',
    dest,
    '--project-environment',
    flutterfowEnv,
    '--include-assets',
  ];
  if (branch) parts.push('--branch-name', branch);

  const cmd = parts.join(' ');
  runner(cmd, { stdio: 'inherit', cwd: repoRoot });
  console.log('✅ FlutterFlow export complete');
  return { success: true };
}
