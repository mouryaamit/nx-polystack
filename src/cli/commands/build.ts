import * as fs from 'fs';
import * as path from 'path';

import { FLUTTER_PLATFORMS, FlutterPlatform, WorkspaceProject } from '../../lib/release/plan';
import { fsTree } from '../../lib/utils/nx-tree';
import { readProjects } from '../../lib/utils/project-json-files';
import { flagBoolean, flagString } from '../args';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

const list = (v: string | undefined): string[] | undefined =>
  v === undefined
    ? undefined
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/** Every project.json of the workspace, with its name (or folder name). */
export function readWorkspaceProjects(root: string): WorkspaceProject[] {
  try {
    return readProjects(fsTree(root));
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

export async function runBuild(
  ctx: CommandContext,
  deps: { spawner?: import('../../lib/release/run').Spawner; now?: () => number } = {},
): Promise<number> {
  for (const f of ['env', 'projects', 'exclude', 'parallel', 'flutterPlatforms', 'report']) {
    if (ctx.flags[f] === true) {
      throw new CliError(`--${f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a value.`);
    }
  }
  const env = flagString(ctx.flags, 'env');
  if (!env) throw new CliError('--env is required, e.g. pstack build --env=uat --all.');
  const all = ctx.flags['all'] !== undefined && flagBoolean(ctx.flags, 'all');
  const projects = list(flagString(ctx.flags, 'projects'));
  const exclude = list(flagString(ctx.flags, 'exclude'));
  for (const [flag, value] of [
    ['--projects', projects],
    ['--exclude', exclude],
  ] as const) {
    if (value !== undefined && value.length === 0) {
      throw new CliError(`${flag} needs at least one project name.`);
    }
  }
  if (all === (projects !== undefined)) {
    throw new CliError('Pass either --all or --projects=<a,b>.');
  }
  const parallelRaw = flagString(ctx.flags, 'parallel') ?? '1';
  const parallel = Number(parallelRaw);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) {
    throw new CliError('--parallel must be a whole number from 1 to 8.');
  }
  const platforms = list(flagString(ctx.flags, 'flutterPlatforms')) ?? ['web'];
  for (const p of platforms) {
    if (!(FLUTTER_PLATFORMS as readonly string[]).includes(p)) {
      throw new CliError(
        `--flutter-platforms: "${p}" is not one of ${FLUTTER_PLATFORMS.join(', ')}.`,
      );
    }
  }
  const continueOnError = ctx.flags['continue'] !== undefined && flagBoolean(ctx.flags, 'continue');
  const report = flagString(ctx.flags, 'report');

  const root = requireWorkspace(ctx.cwd, 'build');
  const { planBuilds } = await import('../../lib/release/plan');
  const { runBuilds, summarize, formatDuration } = await import('../../lib/release/run');

  let plan;
  try {
    plan = planBuilds(readWorkspaceProjects(root), {
      env,
      projects,
      exclude,
      flutterPlatforms: platforms as FlutterPlatform[],
    });
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  if (plan.jobs.length === 0 && plan.missing.length === 0) {
    throw new CliError(
      projects || exclude
        ? 'None of the selected projects has a release target (or Flutter build target).'
        : 'No app with a release target (or Flutter build target) was found.',
    );
  }

  if (ctx.dryRun) {
    console.log(`pstack build --env=${env} — plan (dry run, nothing built):`);
    for (const j of plan.jobs) {
      console.log(`  ▶ npx nx run ${j.project}:${j.target}:${j.configuration}`);
    }
    for (const m of plan.missing)
      console.log(`  – ${m.project}: no ${env} configuration (${m.target})`);
    return 0;
  }

  const startedAt = new Date();
  const clock = deps.now ?? Date.now;
  const start = clock();
  const results = await runBuilds(plan.jobs, {
    cwd: root,
    parallel,
    continueOnError,
    spawner: deps.spawner,
    now: deps.now,
  });
  const totalMs = clock() - start;
  console.log('');
  for (const line of summarize(env, results, plan.missing, totalMs)) console.log(line);

  if (report) {
    const file = path.resolve(ctx.cwd, report);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          env,
          startedAt: startedAt.toISOString(),
          durationMs: totalMs,
          builds: results.map((r) => ({
            project: r.project,
            target: r.target,
            configuration: r.configuration,
            status: r.status,
            durationMs: r.durationMs,
            ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
            ...(r.output ? { output: r.output } : {}),
            ...(r.bytes !== undefined ? { bytes: r.bytes } : {}),
          })),
          missing: plan.missing,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Report: ${path.relative(ctx.cwd, file) || file} (${formatDuration(totalMs)})`);
  }
  return results.some((r) => r.status === 'failed') ? 1 : 0;
}
