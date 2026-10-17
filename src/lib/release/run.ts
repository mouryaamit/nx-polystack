import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { BuildJob } from './plan';

export type BuildStatus = 'passed' | 'failed' | 'skipped';

export interface BuildResult extends BuildJob {
  status: BuildStatus;
  durationMs: number;
  exitCode?: number;
  /** Signal that ended the build, when it was killed. */
  signal?: string;
  /** Size of the output folder after a passed build. */
  bytes?: number;
}

/**
 * Runs one command; resolves with its exit code, or the signal that killed it. onLine receives
 * output lines when piped.
 */
export type Spawner = (
  command: string,
  args: string[],
  opts: { cwd: string; onLine?: (line: string) => void },
) => Promise<number | { signal: string }>;

export interface RunOptions {
  cwd: string;
  /** Builds at once (1: one at a time, output inherited). */
  parallel: number;
  continueOnError: boolean;
  spawner?: Spawner;
  now?: () => number;
  log?: (line: string) => void;
}

/** npx nx run, with inherited output or line-by-line through onLine. */
export const defaultSpawner: Spawner = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: opts.onLine ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32',
    });
    if (opts.onLine) {
      const onLine = opts.onLine;
      for (const stream of [child.stdout, child.stderr]) {
        let rest = '';
        stream?.setEncoding('utf8');
        stream?.on('data', (chunk: string) => {
          const lines = (rest + chunk).split(/\r\n|\r|\n/);
          rest = lines.pop() ?? '';
          lines.forEach(onLine);
        });
        stream?.on('end', () => rest && onLine(rest));
      }
    }
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(signal ? { signal } : code ?? 1));
  });

/**
 * Runs the builds, `parallel` at a time. Without continueOnError the first failure stops new
 * builds (running ones finish); those never started are skipped.
 */
export async function runBuilds(jobs: BuildJob[], o: RunOptions): Promise<BuildResult[]> {
  const spawner = o.spawner ?? defaultSpawner;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(l));
  const results: BuildResult[] = jobs.map((j) => ({ ...j, status: 'skipped', durationMs: 0 }));

  // The builds of one project (Flutter platforms) run one after another, never side by side:
  // they share the project's build folders. Their output is prefixed with the target too.
  const chains = new Map<string, number[]>();
  jobs.forEach((j, i) => chains.set(j.project, [...(chains.get(j.project) ?? []), i]));
  const label = (j: BuildJob) =>
    (chains.get(j.project)?.length ?? 0) > 1 ? `${j.project}:${j.target}` : j.project;
  const width = Math.max(...jobs.map((j) => label(j).length), 1);
  const queue = [...chains.values()];
  let stopped = false;

  const runOne = async (i: number): Promise<void> => {
    const job = jobs[i];
    const started = now();
    const prefix = `[${label(job).padEnd(width)}] `;
    if (o.parallel === 1) log(`\n▶ ${job.project}:${job.target}:${job.configuration}`);
    let code = 1;
    let signal: string | undefined;
    try {
      const ended = await spawner(
        'npx',
        ['nx', 'run', `${job.project}:${job.target}:${job.configuration}`],
        {
          cwd: o.cwd,
          ...(o.parallel > 1 ? { onLine: (line: string) => log(prefix + line) } : {}),
        },
      );
      if (typeof ended === 'number') code = ended;
      else signal = ended.signal;
    } catch (err) {
      log(`${prefix}could not start: ${(err as Error).message}`);
    }
    const r = results[i];
    r.durationMs = now() - started;
    r.exitCode = code;
    if (signal) r.signal = signal;
    r.status = code === 0 && !signal ? 'passed' : 'failed';
    if (r.status === 'passed' && job.output) {
      const bytes = dirSize(path.join(o.cwd, job.output));
      if (bytes !== undefined) r.bytes = bytes;
    }
    if (r.status === 'failed' && !o.continueOnError) stopped = true;
  };

  const worker = async (): Promise<void> => {
    for (let chain = queue.shift(); chain && !stopped; chain = queue.shift()) {
      for (const i of chain) {
        if (stopped) break;
        await runOne(i);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.parallel, chains.size) }, worker));
  return results;
}

/** Total size of a folder's files, or undefined when it does not exist. */
export function dirSize(dir: string): number | undefined {
  if (!fs.existsSync(dir)) return undefined;
  let total = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The summary printed after a run. */
export function summarize(
  env: string,
  results: BuildResult[],
  missing: { project: string; target: string }[],
  totalMs: number,
): string[] {
  const count = (s: BuildStatus) => results.filter((r) => r.status === s).length;
  const skipped = count('skipped');
  const head =
    `pstack build --env=${env} — ${results.length} build(s), ${count('passed')} passed, ` +
    `${count('failed')} failed` +
    (skipped ? `, ${skipped} skipped` : '') +
    (missing.length ? `, ${missing.length} without a ${env} configuration` : '') +
    ` — ${formatDuration(totalMs)}`;
  const nameW = Math.max(...[...results, ...missing].map((r) => r.project.length), 1);
  const targetW = Math.max(...results.map((r) => `${r.target}:${r.configuration}`.length), 1);
  const lines = [head];
  for (const r of results) {
    const mark = r.status === 'passed' ? '✔' : r.status === 'failed' ? '✖' : '–';
    const tail =
      r.status === 'passed'
        ? [r.output, r.bytes !== undefined ? formatBytes(r.bytes) : undefined]
            .filter(Boolean)
            .join('  ')
        : r.status === 'failed'
        ? r.signal
          ? `killed (${r.signal})`
          : `exit ${r.exitCode}`
        : 'skipped';
    lines.push(
      `  ${mark} ${r.project.padEnd(nameW)}  ${`${r.target}:${r.configuration}`.padEnd(
        targetW,
      )}  ` +
        `${r.status === 'skipped' ? '      ' : formatDuration(r.durationMs)}  ${tail}`.trimEnd(),
    );
  }
  for (const m of missing) {
    lines.push(`  – ${m.project.padEnd(nameW)}  no ${env} configuration (${m.target})`);
  }
  return lines;
}
