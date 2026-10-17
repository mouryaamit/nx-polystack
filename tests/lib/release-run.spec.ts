import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BuildJob } from '../../src/lib/release/plan';
import {
  dirSize,
  formatBytes,
  formatDuration,
  runBuilds,
  Spawner,
  summarize,
} from '../../src/lib/release/run';

const job = (project: string, output?: string): BuildJob => ({
  project,
  target: 'release',
  configuration: 'uat',
  ...(output ? { output } : {}),
});

/** A spawner whose exit code per project comes from `codes` (default 0); records calls. */
function fake(codes: Record<string, number> = {}, lines: Record<string, string[]> = {}) {
  const calls: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const spawner: Spawner = async (command, args, opts) => {
    const project = args[2].split(':')[0];
    calls.push(`${command} ${args.join(' ')}`);
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 5));
    (lines[project] ?? []).forEach((l) => opts.onLine?.(l));
    running--;
    return codes[project] ?? 0;
  };
  return { spawner, calls, max: () => maxRunning };
}

describe('runBuilds', () => {
  let root: string;
  let clock: number;
  const now = () => (clock += 1000);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-run-'));
    clock = 0;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('runs one at a time with nx run and records sizes of passed builds', async () => {
    fs.mkdirSync(path.join(root, 'dist/a/sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/a/x.js'), '12345');
    fs.writeFileSync(path.join(root, 'dist/a/sub/y.js'), '123');
    const { spawner, calls, max } = fake();
    const log: string[] = [];
    const results = await runBuilds([job('a', 'dist/a'), job('b', 'dist/none')], {
      cwd: root,
      parallel: 1,
      continueOnError: false,
      spawner,
      now,
      log: (l) => log.push(l),
    });
    expect(calls).toEqual(['npx nx run a:release:uat', 'npx nx run b:release:uat']);
    expect(max()).toBe(1);
    expect(results.map((r) => [r.status, r.bytes, r.durationMs])).toEqual([
      ['passed', 8, 1000],
      ['passed', undefined, 1000],
    ]);
    expect(log).toContain('\n▶ a:release:uat');
  });

  it('stops at the first failure without --continue; the rest are skipped', async () => {
    const { spawner, calls } = fake({ b: 2 });
    const results = await runBuilds([job('a'), job('b'), job('c')], {
      cwd: root,
      parallel: 1,
      continueOnError: false,
      spawner,
      now,
      log: () => undefined,
    });
    expect(calls).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(results[1].exitCode).toBe(2);
  });

  it('runs everything with --continue', async () => {
    const { spawner, calls } = fake({ a: 1 });
    const results = await runBuilds([job('a'), job('b')], {
      cwd: root,
      parallel: 1,
      continueOnError: true,
      spawner,
      now,
      log: () => undefined,
    });
    expect(calls).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(['failed', 'passed']);
  });

  it('runs up to --parallel at once and prefixes their output', async () => {
    const { spawner, max } = fake({}, { a: ['hello'], bb: ['world'] });
    const log: string[] = [];
    await runBuilds([job('a'), job('bb'), job('c'), job('d')], {
      cwd: root,
      parallel: 2,
      continueOnError: false,
      spawner,
      now,
      log: (l) => log.push(l),
    });
    expect(max()).toBe(2);
    expect(log).toEqual(expect.arrayContaining(['[a ] hello', '[bb] world']));
  });

  it('counts a spawner error as a failure', async () => {
    const results = await runBuilds([job('a')], {
      cwd: root,
      parallel: 1,
      continueOnError: true,
      spawner: () => Promise.reject(new Error('ENOENT')),
      now,
      log: () => undefined,
    });
    expect(results[0]).toMatchObject({ status: 'failed', exitCode: 1 });
  });
});

describe('runBuilds robustness', () => {
  it('never runs two builds of one project at once and prefixes them with the target', async () => {
    let running = 0;
    let overlap = false;
    const log: string[] = [];
    const spawner: Spawner = async (_c, args, opts) => {
      const [project, target] = args[2].split(':');
      if (project === 'mob') {
        running++;
        overlap ||= running > 1;
      }
      await new Promise((r) => setTimeout(r, 5));
      opts.onLine?.(`hi from ${target}`);
      if (project === 'mob') running--;
      return 0;
    };
    const jobs: BuildJob[] = [
      { project: 'mob', target: 'build-web', configuration: 'uat' },
      { project: 'mob', target: 'build-android', configuration: 'uat' },
      { project: 'web', target: 'release', configuration: 'uat' },
    ];
    await runBuilds(jobs, {
      cwd: '.',
      parallel: 3,
      continueOnError: false,
      spawner,
      log: (l) => log.push(l),
    });
    expect(overlap).toBe(false);
    expect(log).toEqual(
      expect.arrayContaining([
        '[mob:build-web    ] hi from build-web',
        '[mob:build-android] hi from build-android',
        '[web              ] hi from release',
      ]),
    );
  });

  it('logs why a build could not start and reports a killed build', async () => {
    const log: string[] = [];
    const results = await runBuilds([job('a'), job('b')], {
      cwd: '.',
      parallel: 1,
      continueOnError: true,
      spawner: async (_c, args) => {
        if (args[2].startsWith('a')) throw new Error('spawn npx ENOENT');
        return { signal: 'SIGKILL' };
      },
      log: (l) => log.push(l),
    });
    expect(log).toContain('[a] could not start: spawn npx ENOENT');
    expect(results[1]).toMatchObject({ status: 'failed', signal: 'SIGKILL' });
    expect(summarize('uat', results, [], 0)[2]).toContain('killed (SIGKILL)');
  });
});

describe('summary helpers', () => {
  it('formats durations, sizes and the summary', () => {
    expect(formatDuration(372_000)).toBe('6m 12s');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(4.1 * 1024 * 1024)).toBe('4.1 MB');
    expect(dirSize('/no/such/dir')).toBeUndefined();
    const lines = summarize(
      'uat',
      [
        {
          ...job('portal', 'dist/apps/portal'),
          status: 'passed',
          durationMs: 123_000,
          bytes: 4.1 * 1024 * 1024,
        },
        { ...job('admin'), status: 'failed', durationMs: 41_000, exitCode: 1 },
        { ...job('ops'), status: 'skipped', durationMs: 0 },
      ],
      [{ project: 'reports', target: 'release' }],
      372_000,
    );
    expect(lines[0]).toBe(
      'pstack build --env=uat — 3 build(s), 1 passed, 1 failed, 1 skipped, 1 without a uat configuration — 6m 12s',
    );
    expect(lines[1]).toBe('  ✔ portal   release:uat  2m 03s  dist/apps/portal  4.1 MB');
    expect(lines[2]).toBe('  ✖ admin    release:uat  0m 41s  exit 1');
    expect(lines[3]).toBe('  – ops      release:uat          skipped');
    expect(lines[4]).toBe('  – reports  no uat configuration (release)');
  });
});
