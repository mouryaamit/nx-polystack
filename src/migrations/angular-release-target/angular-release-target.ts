import { GeneratorCallback, logger, readJson, Tree, updateJson, writeJson } from '@nx/devkit';

import { ensureAngularDependencies } from '../../lib/utils/angular-deps';
import {
  angularBuildTarget,
  POLYSTACK_BUILD_EXECUTOR,
  RELEASE_CONFIGURATIONS,
} from '../../lib/utils/angular-project';

interface Target {
  executor?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, Target>;
  browserTarget?: string;
  [key: string]: unknown;
}

const SERVE_RENAME: Record<string, string> = { dev: 'development', uat: 'uat', prod: 'production' };

/** v0.4.0: old generated Angular apps had `build` = plugin pipeline with no Angular builder options. */
export default async function angularReleaseTarget(
  tree: Tree,
): Promise<GeneratorCallback | undefined> {
  if (!tree.exists('apps')) return undefined;
  const migrated: { name: string; keys: string[] }[] = [];

  for (const app of tree.children('apps')) {
    const pjPath = `apps/${app}/project.json`;
    if (!tree.exists(pjPath)) continue;
    const pj = readJson(tree, pjPath);
    const build: Target | undefined = pj.targets?.build;
    if (!build || build.executor !== POLYSTACK_BUILD_EXECUTOR || build.options?.main) continue;
    if (build.options?.type !== 'angular') continue;
    const name: string = pj.name ?? app;
    if (pj.targets.release) {
      logger.warn(`angular-release-target: apps/${app} already has a "release" target — skipped.`);
      continue;
    }

    const release: Target = {
      ...build,
      options: { ...build.options, buildTarget: `${name}:build` },
    };
    release.configurations = Object.fromEntries(
      Object.entries(build.configurations ?? {}).map(([cfg, value]) => [
        cfg,
        { ...value, buildConfiguration: RELEASE_CONFIGURATIONS[cfg]?.buildConfiguration ?? cfg },
      ]),
    );
    pj.targets.release = release;
    const newBuild = angularBuildTarget(app) as Target;
    const newConfigs = newBuild.configurations as Record<string, unknown>;
    for (const cfg of Object.keys(build.configurations ?? {})) {
      if (cfg in RELEASE_CONFIGURATIONS) continue;
      newConfigs[cfg] = {
        ...(newConfigs['production'] as Record<string, unknown>),
        fileReplacements: [
          {
            replace: `environments/${app}/environment.ts`,
            with: `environments/${app}/environment.${cfg}.ts`,
          },
        ],
      };
    }
    pj.targets.build = newBuild;

    for (const value of Object.values(
      (pj.targets.serve?.configurations ?? {}) as Record<string, Target>,
    )) {
      const m = /^(.+):build:(dev|uat|prod)$/.exec(value.browserTarget ?? '');
      if (m) value.browserTarget = `${m[1]}:build:${SERVE_RENAME[m[2]]}`;
    }

    writeJson(tree, pjPath, pj);
    migrated.push({ name, keys: Object.keys(build.configurations ?? {}) });
  }

  if (migrated.length === 0) return undefined;

  updateJson(tree, 'package.json', (pkg) => {
    for (const [key, cmd] of Object.entries((pkg.scripts ?? {}) as Record<string, string>)) {
      let next = cmd;
      for (const { name, keys } of migrated) {
        if (keys.length === 0) continue;
        const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const re = new RegExp(
          `(^|\\s)nx run ${name.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          )}:build:(${alt})(?=\\s|$)( --(?=\\s|$))?`,
          'g',
        );
        next = next.replace(re, `$1nx run ${name}:release:$2`);
      }
      if (next !== cmd) pkg.scripts[key] = next;
    }
    return pkg;
  });

  return ensureAngularDependencies(tree);
}
