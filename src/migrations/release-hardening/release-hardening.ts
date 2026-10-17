import { GeneratorCallback, logger, readJson, Tree, writeJson } from '@nx/devkit';

import { DEFAULT_DROP_CONSOLE } from '../../lib/hardening/options';
import { POLYSTACK_BUILD_EXECUTOR, withReleaseHardening } from '../../lib/utils/angular-project';
import { ensureReleaseHardeningDependencies } from '../../lib/utils/dependencies';
import { projectJsonFiles } from '../../lib/utils/project-json-files';

type Options = Record<string, unknown>;

interface Target {
  executor?: string;
  options?: Options;
  configurations?: Record<string, Options>;
}

/**
 * v0.29.0: polystack release targets turn on the leak check, source-map guard, comment stripping
 * and console removal for their UAT/PROD configurations (values already set are kept); the
 * replaced `harden` option is removed (other envs it applied to keep its meaning); terser is added
 * to the workspace devDependencies.
 */
export default async function releaseHardening(tree: Tree): Promise<GeneratorCallback | undefined> {
  const changed: string[] = [];
  const hardenMapped: string[] = [];
  for (const file of projectJsonFiles(tree)) {
    let project: { name?: string; targets?: Record<string, Target> };
    try {
      project = readJson(tree, file);
    } catch {
      continue;
    }
    const name = project.name ?? file.split('/').slice(-2, -1)[0];
    let touched = false;
    for (const target of Object.values(project.targets ?? {})) {
      if (target.executor !== POLYSTACK_BUILD_EXECUTOR) continue;
      const result = hardenTarget(target);
      touched = result.changed || touched;
      hardenMapped.push(...result.hardenMapped.map((c) => `${name}:${c}`));
    }
    if (!touched) continue;
    writeJson(tree, file, project);
    changed.push(name);
  }
  if (changed.length === 0) return undefined;

  logger.info(
    `release-hardening: updated release hardening for ${changed.join(', ')}. ` +
      'leakCheck/sourceMaps fail the build on a hit; set them to "warn" to report only.',
  );
  if (hardenMapped.length > 0) {
    logger.info(
      `release-hardening: harden replaced by stripComments and dropConsole in ${hardenMapped.join(
        ', ',
      )}.`,
    );
  }
  return ensureReleaseHardeningDependencies(tree);
}

/**
 * Hardens one release target in place. UAT/PROD configurations get every hardening option; other
 * non-DEV configurations that `harden: true` applied to keep its meaning (stripComments and the
 * default dropConsole). A key set in the configuration or the target options is kept. `harden`
 * is removed everywhere.
 */
function hardenTarget(target: Target): { changed: boolean; hardenMapped: string[] } {
  const options = target.options ?? {};
  const hardenMapped: string[] = [];
  let changed = false;
  for (const [name, config] of Object.entries(target.configurations ?? {})) {
    const env = config['env'] ?? options['env'];
    const harden = (config['harden'] ?? options['harden']) === true;
    changed = removeHarden(config) || changed;
    if (typeof env !== 'string') continue;
    const wanted = releaseOptionsFor(env, harden);
    if (!wanted) continue;
    const added = Object.entries(wanted).filter(([key]) => !(key in config) && !(key in options));
    for (const [key, value] of added) config[key] = value;
    changed = changed || added.length > 0;
    if (harden && !isReleaseEnv(env) && added.length > 0) hardenMapped.push(name);
  }
  changed = removeHarden(target.options) || changed;
  return { changed, hardenMapped };
}

/** The options a configuration should end up with, or undefined for none. */
function releaseOptionsFor(env: string, harden: boolean): Options | undefined {
  if (isReleaseEnv(env)) {
    const { env: _env, ...hardening } = withReleaseHardening({ env });
    return hardening;
  }
  if (harden && env.toUpperCase() !== 'DEV') {
    return { stripComments: true, dropConsole: [...DEFAULT_DROP_CONSOLE] };
  }
  return undefined;
}

function isReleaseEnv(env: string): boolean {
  return ['UAT', 'PROD'].includes(env.toUpperCase());
}

function removeHarden(options: Options | undefined): boolean {
  if (!options || !('harden' in options)) return false;
  delete options['harden'];
  return true;
}
