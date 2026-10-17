import { spawnSync } from 'child_process';

/** Only npm needs a shell on Windows (npm.cmd); git.exe resolves directly. */
const useShell = (cmd: string): boolean => process.platform === 'win32' && cmd === 'npm';

/**
 * Run a command with inherited stdio; throw if it exits non-zero.
 * `args` may contain spaces, except for `npm`: on Windows npm runs through a shell
 * (so npm.cmd resolves), which re-parses its args, so they must be fixed tokens.
 */
export function execOrThrow(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: useShell(cmd) });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `"${cmd} ${args.join(' ')}" exited with code ${r.status ?? `signal ${r.signal}`}`,
    );
  }
}

export function hasGit(): boolean {
  const r = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

/** `git status --porcelain` output, or null when cwd is not a git repo / git is missing. */
export function gitStatus(cwd: string): string | null {
  const r = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}
