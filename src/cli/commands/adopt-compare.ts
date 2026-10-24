import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Check, compareBuilds, renderReport } from '../../lib/adopt/compare';
import { flagString } from '../args';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

export interface CompareDeps {
  /** Run a command with inherited stdio; throws on a non-zero exit. */
  exec(cmd: string, args: string[], cwd: string, env?: Record<string, string>): void;
  /** Run a command and return its stdout, or null when it fails. */
  capture(cmd: string, args: string[], cwd: string): string | null;
  log(line: string): void;
}

const useShell = (cmd: string) => process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx');

const defaultDeps: CompareDeps = {
  exec(cmd, args, cwd, env) {
    const r = spawnSync(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: useShell(cmd),
      env: env ? { ...process.env, ...env } : process.env,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`"${cmd} ${args.join(' ')}" exited with code ${r.status}`);
  },
  capture(cmd, args, cwd) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  },
  log: (line) => console.log(line),
};

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
}

/** The app's project.json under a workspace root (apps/<app> or any project.json naming it). */
function projectJson(root: string, app: string): Json | null {
  const direct = path.join(root, 'apps', app, 'project.json');
  if (fs.existsSync(direct)) return readJson(direct);
  const walk = (dir: string, depth: number): Json | null => {
    if (depth > 4) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const pj = path.join(dir, e.name, 'project.json');
      if (fs.existsSync(pj)) {
        const json = readJson(pj);
        if (json['name'] === app) return json;
      }
      const found = walk(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(root, 0);
}

function outputPath(pj: Json | null, target: string, app: string): string {
  const targets = (pj?.['targets'] ?? {}) as Record<string, Json>;
  const options = (targets[target]?.['options'] ?? {}) as Json;
  return typeof options['outputPath'] === 'string'
    ? (options['outputPath'] as string)
    : `dist/apps/${app}`;
}

function copyDir(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/**
 * pstack adopt --compare --app=<app> [--env=dev,uat,prod] [--base=<commit>]: builds the app with
 * the workspace's own script at <commit> (in a temporary git worktree) and with its release
 * target, for each env, and compares the two outputs.
 */
export async function runAdoptCompare(
  ctx: CommandContext,
  deps: CompareDeps = defaultDeps,
): Promise<number> {
  const root = requireWorkspace(ctx.cwd, 'adopt');
  const app = flagString(ctx.flags, 'app');
  if (!app || app.includes(',')) {
    throw new CliError('--compare builds one app: pass --app=<app>.');
  }
  const pj = projectJson(root, app);
  const release = ((pj?.['targets'] ?? {}) as Record<string, Json>)['release'];
  if (!release) {
    throw new CliError(`${app} has no release target yet; run pstack adopt first.`);
  }
  const configs = Object.keys((release['configurations'] ?? {}) as Json);
  const envFlag = flagString(ctx.flags, 'env');
  const envs = envFlag
    ? envFlag
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
    : configs;
  const unknown = envs.filter((e) => !configs.includes(e));
  if (unknown.length > 0) {
    throw new CliError(
      `${app}:release has no ${unknown.join(', ')} configuration (has ${configs.join(', ')}).`,
    );
  }

  const status = deps.capture('git', ['status', '--porcelain'], root);
  if (status === null) throw new CliError('--compare needs a git repository.');
  let base = flagString(ctx.flags, 'base');
  if (!base) {
    if (status.trim() === '') {
      throw new CliError(
        'pass --base=<commit before adopt> (the working tree is clean, so adopt is committed).',
      );
    }
    base = 'HEAD';
  }
  if (deps.capture('git', ['rev-parse', '--verify', `${base}^{commit}`], root) === null) {
    throw new CliError(`--base: no commit "${base}".`);
  }

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), `pstack-compare-${app}-`));
  fs.rmSync(worktree, { recursive: true, force: true });
  const out = path.join(root, 'dist', 'pstack-compare', app);
  const env = { NX_DAEMON: 'false', NX_SKIP_NX_CACHE: 'true' };
  const byEnv: Record<string, Check[]> = {};
  deps.log(`Old build: ${app} at ${base}, in a temporary worktree (${worktree}).`);
  deps.exec('git', ['worktree', 'add', '--detach', worktree, base], root);
  try {
    fs.symlinkSync(
      path.join(root, 'node_modules'),
      path.join(worktree, 'node_modules'),
      'junction',
    );
    const oldPkg = readJson(path.join(worktree, 'package.json'));
    const oldScripts = (oldPkg['scripts'] ?? {}) as Record<string, string>;
    const oldOut = outputPath(projectJson(worktree, app), 'build', app);
    const newOut = outputPath(pj, 'release', app);
    for (const e of envs) {
      const script = `build:${app}:${e}`;
      if (!oldScripts[script]) {
        throw new CliError(`${base} has no "${script}" npm script to build the old way.`);
      }
      deps.log(`\n▶ ${e}: old build (npm run ${script} at ${base})`);
      deps.exec('npm', ['run', script], worktree, env);
      copyDir(path.join(worktree, oldOut), path.join(out, e, 'old'));
      deps.log(`\n▶ ${e}: new build (nx run ${app}:release:${e})`);
      deps.exec('npx', ['nx', 'run', `${app}:release:${e}`], root, env);
      copyDir(path.join(root, newOut), path.join(out, e, 'new'));
      byEnv[e] = compareBuilds(path.join(out, e, 'old'), path.join(out, e, 'new'));
    }
  } finally {
    try {
      deps.exec('git', ['worktree', 'remove', '--force', worktree], root);
    } catch {
      deps.log(`Remove the worktree by hand: git worktree remove --force ${worktree}`);
    }
  }

  const reportFile = path.join(out, 'report.md');
  fs.writeFileSync(reportFile, renderReport(app, base, byEnv));
  let differs = 0;
  for (const [e, checks] of Object.entries(byEnv)) {
    deps.log(`\n${e}:`);
    for (const c of checks) {
      if (c.status === 'differs') differs++;
      deps.log(
        `  ${c.status === 'differs' ? '✖' : c.status === 'same' ? '✔' : 'ℹ'} ${c.name}: ${
          c.detail
        }`,
      );
    }
  }
  deps.log(
    `\n${differs === 0 ? 'No differences that matter.' : `${differs} check(s) differ.`} ` +
      `Report: ${path.relative(root, reportFile)}; builds under ${path.relative(
        root,
        out,
      )}/<env>/{old,new}.`,
  );
  return differs === 0 ? 0 : 1;
}
