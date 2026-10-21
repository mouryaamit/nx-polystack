import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import { CleanExecutorSchema } from './schema.d';

export type Runner = (cmd: string, opts: ExecSyncOptions) => void;

const defaultRunner: Runner = (cmd, opts) => {
  console.log(`▶ ${cmd}`);
  execSync(cmd, opts);
};

/** Workspace folders that only hold build output; anything below them may be removed. */
const OUTPUT_ROOTS = new Set(['dist', 'coverage', 'tmp']);
/** Output folders inside a project (e.g. Ionic www, Flutter build). */
const PROJECT_OUTPUT_DIRS = new Set(['www', 'build', 'dist', 'coverage', 'out', 'tmp']);

const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '') || '.';

/**
 * Why `rel` may not be cleaned, or null. Allowed: something below dist/, coverage/ or tmp/, or an
 * output folder of the project (www, build, dist, coverage, out, tmp under its root). Folder names
 * are compared case-insensitively (macOS and Windows file systems).
 */
export function cleanPathProblem(rel: unknown, projectRoot: string): string | null {
  if (typeof rel !== 'string' || rel.trim() === '') return 'is empty';
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    return 'must be relative to the workspace';
  }
  const target = norm(rel).toLowerCase();
  if (target === '.') return 'is the workspace root';
  if (target === '..' || target.startsWith('../')) return 'is outside the workspace';
  const segments = target.split('/');
  if (segments.includes('node_modules') || segments.includes('.git')) {
    return 'is inside node_modules or .git';
  }
  const project = norm(projectRoot).toLowerCase();
  if (project === '.' ? false : project === target || project.startsWith(`${target}/`)) {
    return 'holds the project itself';
  }
  if (OUTPUT_ROOTS.has(segments[0])) return segments.length > 1 ? null : 'is a whole output root';
  const inProject =
    project === '.'
      ? segments
      : target.startsWith(`${project}/`)
      ? target.slice(project.length + 1).split('/')
      : null;
  if (
    inProject &&
    PROJECT_OUTPUT_DIRS.has(inProject[0]) &&
    !(project === '.' && OUTPUT_ROOTS.has(inProject[0]))
  ) {
    return null;
  }
  return (
    'is not below dist/, coverage/ or tmp/, nor an output folder of the project ' +
    `(${[...PROJECT_OUTPUT_DIRS].join(', ')} in ${projectRoot})`
  );
}

/** Whether the real (symlink-resolved) location of `abs` stays inside `root`. */
export function staysInside(root: string, abs: string): boolean {
  const realRoot = fs.realpathSync(root);
  // The path itself may be a symlink (rm removes the link only); its parent folder must be real.
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  const real = fs.realpathSync(dir);
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

/** Whether `cmd` is on PATH (with PATHEXT on Windows). */
export function onPath(cmd: string): boolean {
  const exts =
    process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => exts.some((ext) => fs.existsSync(path.join(dir, cmd + ext))));
}

/** Removes the project's build outputs; `flutter: true` also runs `flutter clean`. */
export default async function cleanExecutor(
  options: CleanExecutorSchema,
  context: ExecutorContext,
  runner: Runner = defaultRunner,
  hasCommand: (cmd: string) => boolean = onPath,
): Promise<{ success: boolean }> {
  const projectName = context.projectName ?? '';
  const projectRoot =
    context.projectsConfigurations?.projects?.[projectName]?.root ??
    `apps/${projectName}`;
  if (options.paths !== undefined && !Array.isArray(options.paths)) {
    console.error('✖ clean: "paths" must be a list of workspace-relative paths');
    return { success: false };
  }
  const paths = options.paths ?? [];

  const problems = paths
    .map((p) => [p, cleanPathProblem(p, projectRoot)] as const)
    .filter(([, why]) => why !== null)
    .map(([p, why]) => `"${String(p)}" ${why}`);
  for (const p of paths) {
    if (!problems.length && !staysInside(context.root, path.join(context.root, p))) {
      problems.push(`"${p}" leads outside the workspace through a symlink`);
    }
  }
  if (problems.length > 0) {
    console.error(`✖ clean: refused — ${problems.join('; ')}`);
    return { success: false };
  }

  for (const rel of paths) {
    const abs = path.join(context.root, rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
      console.log(`✔ removed ${rel}`);
    } else {
      console.log(`– ${rel} (not there)`);
    }
  }

  if (options.flutter && !hasCommand('flutter')) {
    console.warn('⚠ flutter clean skipped: the flutter CLI is not on PATH');
  } else if (options.flutter) {
    const cwd = path.join(context.root, projectRoot);
    try {
      runner('flutter clean', { stdio: 'inherit', cwd });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { status?: number };
      // 127: command not found (shell); ENOENT: no shell lookup.
      if (e.code === 'ENOENT' || e.status === 127) {
        console.warn('⚠ flutter clean skipped: the flutter CLI is not on PATH');
      } else {
        console.error(`✖ flutter clean failed: ${e.message.split('\n')[0]}`);
        return { success: false };
      }
    }
  }
  return { success: true };
}
