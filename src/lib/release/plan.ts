import { POLYSTACK_BUILD_EXECUTOR } from '../utils/angular-project';

export const FLUTTER_BUILD_EXECUTOR = '@mouryaamit/nx-polystack:flutter-build';
export const FLUTTER_PLATFORMS = ['web', 'android', 'ios'] as const;
export type FlutterPlatform = (typeof FLUTTER_PLATFORMS)[number];

/** A project.json as read from the workspace. */
export interface WorkspaceProject {
  name: string;
  /** Folder of the project.json, relative to the workspace root. */
  root: string;
  json: Record<string, unknown>;
}

export interface BuildJob {
  project: string;
  target: string;
  configuration: string;
  /** Output folder relative to the workspace root, when the target names one. */
  output?: string;
}

export interface BuildPlan {
  jobs: BuildJob[];
  /** Projects with a release/build-web target but no configuration for the env. */
  missing: { project: string; target: string }[];
}

export interface PlanOptions {
  env: string;
  /** Limit to these project names (all when absent). */
  projects?: string[];
  exclude?: string[];
  flutterPlatforms?: FlutterPlatform[];
}

type Target = {
  executor?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, Record<string, unknown>>;
};

const SAFE_NAME = /^[\w.@/-]+$/;

const FLUTTER_TARGETS: Record<FlutterPlatform, string> = {
  web: 'build-web',
  android: 'build-android',
  ios: 'build-ios',
};

/** The configuration named env, else the one whose env option equals it (any case). */
export function configurationFor(target: Target, env: string): string | undefined {
  const configs = target.configurations ?? {};
  const wanted = env.toLowerCase();
  const byName = Object.keys(configs).find((c) => c.toLowerCase() === wanted);
  if (byName) return byName;
  return Object.keys(configs).find(
    (c) => String(configs[c]?.['env'] ?? '').toLowerCase() === wanted,
  );
}

/**
 * Release builds of every app for one env: the polystack build target of Angular/Ionic apps and
 * the Flutter build targets of the chosen platforms. Unknown names in projects/exclude throw.
 */
export function planBuilds(all: WorkspaceProject[], o: PlanOptions): BuildPlan {
  const names = new Set(all.map((p) => p.name));
  const unknown = [...(o.projects ?? []), ...(o.exclude ?? [])].filter((n) => !names.has(n));
  if (unknown.length > 0) {
    throw new Error(`unknown project(s): ${[...new Set(unknown)].join(', ')}`);
  }
  const only = o.projects ? new Set(o.projects) : undefined;
  const skip = new Set(o.exclude ?? []);
  const platforms = o.flutterPlatforms ?? ['web'];
  const plan: BuildPlan = { jobs: [], missing: [] };

  for (const p of [...all].sort((a, b) => a.name.localeCompare(b.name))) {
    if ((only && !only.has(p.name)) || skip.has(p.name)) continue;
    const targets = (p.json['targets'] ?? {}) as Record<string, Target>;
    const chosen: [string, Target][] = [];
    const release = Object.entries(targets).find(
      ([, t]) => t.executor === POLYSTACK_BUILD_EXECUTOR,
    );
    if (release) chosen.push(release);
    for (const platform of platforms) {
      const name = FLUTTER_TARGETS[platform];
      const t = targets[name];
      if (t?.executor === FLUTTER_BUILD_EXECUTOR) chosen.push([name, t]);
    }
    for (const [target, t] of chosen) {
      const configuration = configurationFor(t, o.env);
      if (!configuration) {
        plan.missing.push({ project: p.name, target });
        continue;
      }
      // These end up on the command line.
      for (const part of [p.name, target, configuration]) {
        if (!SAFE_NAME.test(part)) {
          throw new Error(`"${part}" (${p.root}) is not a name pstack build can run`);
        }
      }
      const merged = { ...(t.options ?? {}), ...(t.configurations?.[configuration] ?? {}) };
      const out = merged['outputPath'] ?? merged['dist'];
      plan.jobs.push({
        project: p.name,
        target,
        configuration,
        ...(typeof out === 'string' ? { output: out } : {}),
      });
    }
  }
  return plan;
}
