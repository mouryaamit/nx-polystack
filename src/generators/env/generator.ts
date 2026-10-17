import { Tree, formatFiles, logger, readJson, updateJson } from '@nx/devkit';

import { EnvEncryptionConfig, normalizeEnvEncryption } from '../../lib/env-encryption/config';
import { normalizeHosts } from '../../lib/env-encryption/domains';
import { initialEnvEncryption, readEnvEncryptionBlock } from '../../lib/env-encryption/workspace';
import { deriveEnvFile, deriveFlutterEnv } from '../../lib/env/derive';
import { configurationFor } from '../../lib/release/plan';
import { POLYSTACK_BUILD_EXECUTOR, RELEASE_HARDENING } from '../../lib/utils/angular-project';
import { checkBaseHref } from '../../lib/utils/base-href';
import { findProjects, refreshLlmBlocks } from '../../lib/utils/llm-block';
import { addNpmScripts } from '../../lib/utils/npm-scripts';

import { EnvGeneratorSchema } from './schema.d';

const RESERVED = new Set(['dev', 'development', 'uat', 'prod', 'production']);
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

interface AngularApp {
  name: string;
  /** Project folder, e.g. apps/web or apps/legacy/web. */
  root: string;
  /** Directory containing the env files, e.g. "environments/web" or "apps/web/src/environments" */
  envDir: string;
  /** Base env filename, e.g. "environment.ts" */
  baseEnvFile: string;
}

/** Flutter app using @mouryaamit/nx-polystack:flutter-build — has configurations blocks */
interface FlutterPluginApp {
  kind: 'plugin';
  name: string;
  root: string;
}

/** Flutter app using nx:run-commands with {args.env} — no configurations needed */
interface FlutterRunCommandsApp {
  kind: 'run-commands';
  name: string;
  root: string;
}

type FlutterApp = FlutterPluginApp | FlutterRunCommandsApp;

export default async function envGenerator(tree: Tree, options: EnvGeneratorSchema): Promise<void> {
  const { name, apiUrl, production, baseHref } = options;
  // Without --from: uat, else prod (migrated apps may only have production).
  const sources = options.from ? [options.from] : ['uat', 'prod'];

  if (!NAME_RE.test(name)) {
    throw new Error(
      `env generator: --name="${name}" must be lowercase kebab-case (e.g. qa, sit, staging).`,
    );
  }
  if (RESERVED.has(name)) {
    throw new Error(
      `env generator: "${name}" is a reserved environment name. Reserved: ${[...RESERVED].join(
        ', ',
      )}.`,
    );
  }
  if (!options.all && !(options.projects && options.projects.length > 0)) {
    throw new Error(
      'env generator: name the apps (--app=<a,b>) or pass --all; nothing was changed.',
    );
  }
  if (apiUrl !== undefined && !/^https?:\/\/[^\s"'`\\]+$/.test(apiUrl)) {
    throw new Error(`env generator: --api-url must be an http(s) URL (got "${apiUrl}").`);
  }
  if (baseHref !== undefined) {
    try {
      checkBaseHref(baseHref);
    } catch (err) {
      throw new Error(`env generator: ${(err as Error).message}`);
    }
  }
  let domains: string[] | undefined;
  if (options.domains && options.domains.length > 0) {
    try {
      domains = normalizeHosts(options.domains);
    } catch (err) {
      throw new Error(`env generator: --domains: ${(err as Error).message}`);
    }
  }

  let angularApps = detectAngularApps(tree);
  let flutterApps = detectFlutterApps(tree);
  if (!options.all) {
    const wanted = new Set(options.projects);
    const known = new Set([...angularApps, ...flutterApps].map((a) => a.name));
    const unknown = [...wanted].filter((n) => !known.has(n));
    if (unknown.length > 0) {
      throw new Error(
        `env generator: no app with environments named ${unknown.join(', ')} ` +
          `(apps with environments: ${[...known].sort().join(', ') || 'none'}).`,
      );
    }
    angularApps = angularApps.filter((a) => wanted.has(a.name));
    flutterApps = flutterApps.filter((a) => wanted.has(a.name));
  }
  if (angularApps.length === 0 && flutterApps.length === 0) {
    throw new Error(
      'env generator: no apps detected. ' +
        'Angular/Ionic apps need a build.configurations entry with fileReplacements in project.json; ' +
        'Flutter apps need build-web/build-android/build-ios targets and an env/ directory.',
    );
  }

  // Everything is checked before anything is written.
  const problems: string[] = [];
  const angularPlans = angularApps.map((app) => {
    const plan = planAngularFrom(tree, app, name, sources);
    problems.push(...plan.problems);
    return plan;
  });
  const flutterPlans = flutterApps.map((app) => {
    const plan = planFlutter(tree, app, name, sources, Boolean(options.from));
    problems.push(...plan.problems);
    return plan;
  });
  const byFile = new Map<string, string[]>();
  for (const p of angularPlans)
    byFile.set(p.newEnvFile, [...(byFile.get(p.newEnvFile) ?? []), p.app.name]);
  for (const [file, apps] of byFile) {
    if (apps.length > 1) problems.push(`${apps.join(' and ')} would all write ${file}`);
  }
  let cfg: EnvEncryptionConfig | undefined;
  try {
    cfg = workspaceEncryption(tree);
  } catch (err) {
    problems.push(`nx.json pstack.envEncryption: ${(err as Error).message}`);
  }
  if (problems.length > 0 || !cfg) {
    throw new Error(
      `env generator: nothing was changed:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  const npmScripts: Record<string, string> = {};
  const notes: string[] = [];
  const placeholders: string[] = [];

  // ── Angular / Ionic ────────────────────────────────────────────────────────
  for (const plan of angularPlans) {
    const { app } = plan;
    const derived = deriveEnvFile(tree.read(plan.sourceEnvFile, 'utf-8') as string, {
      env: name,
      app: app.name,
      envProject: plan.envProject,
      cfg,
      apiUrl,
      production,
      // Only the release target fills ${…} placeholders; other builds copy the values.
      placeholders: plan.hasRelease,
    });
    tree.write(plan.newEnvFile, derived.text);
    placeholders.push(...derived.placeholders);
    notes.push(...derived.notes.map((n) => `${app.name}: ${n}`));
    if (!plan.hasRelease) {
      notes.push(
        `${app.name}: has no release target, so secret values were copied from ${plan.from} as they are.`,
      );
    }

    updateJson(tree, `${app.root}/project.json`, (json: Record<string, unknown>) => {
      const targets = (json['targets'] ?? {}) as Record<string, Record<string, unknown>>;

      const buildTarget = (targets['build'] ?? {}) as Record<string, unknown>;
      const buildConfigs = (buildTarget['configurations'] ?? {}) as Record<string, unknown>;
      buildConfigs[name] = angularBuildConfig(
        app,
        plan.newEnvFile,
        buildConfigs[plan.sourceBuildConfig],
      );
      buildTarget['configurations'] = buildConfigs;
      targets['build'] = buildTarget;

      const serveTarget = targets['serve'] as Record<string, unknown> | undefined;
      if (serveTarget) {
        const serveConfigs = (serveTarget['configurations'] ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        const options = (serveTarget['options'] ?? {}) as Record<string, unknown>;
        const usesBuildTarget =
          'buildTarget' in options ||
          Object.values(serveConfigs).some((c) => c && 'buildTarget' in c) ||
          (!('browserTarget' in options) &&
            !Object.values(serveConfigs).some((c) => c && 'browserTarget' in c) &&
            /@nx\/angular|@angular\/build:/.test(String(serveTarget['executor'] ?? '')));
        const key = usesBuildTarget ? 'buildTarget' : 'browserTarget';
        // The source serve configuration's other settings (port, proxy) come along.
        const sourceServe = serveConfigs[plan.sourceBuildConfig] ?? serveConfigs[plan.from] ?? {};
        const copy = JSON.parse(JSON.stringify(sourceServe)) as Record<string, unknown>;
        delete copy['browserTarget'];
        delete copy['buildTarget'];
        serveConfigs[name] = { ...copy, [key]: `${app.name}:build:${name}` };
        serveTarget['configurations'] = serveConfigs;
      }

      const release = releaseTargetOf(targets);
      if (release) {
        const releaseConfigs = (release.target['configurations'] ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        const source = plan.sourceRelease ? releaseConfigs[plan.sourceRelease] : undefined;
        const conf: Record<string, unknown> = source
          ? JSON.parse(JSON.stringify(source))
          : { ...RELEASE_HARDENING, dropConsole: [...RELEASE_HARDENING.dropConsole] };
        conf['env'] = name.toUpperCase();
        conf['buildConfiguration'] = name;
        if (domains) conf['domains'] = domains;
        else if (conf['domains'] !== undefined) {
          delete conf['domains'];
          notes.push(
            `${app.name}: the ${plan.from} domain lock was not copied; set it with ` +
              `pstack encryption --app=${app.name} --domains=${name}=<hosts>.`,
          );
        }
        if (baseHref !== undefined) conf['baseHref'] = baseHref;
        else if (typeof conf['baseHref'] === 'string') {
          notes.push(
            `${app.name}: base href ${conf['baseHref']} copied from ${plan.from} ` +
              `(pstack release --app=${app.name} --configuration=${name} --base-href=… changes it).`,
          );
        }
        releaseConfigs[name] = conf;
        release.target['configurations'] = releaseConfigs;
      }

      json['targets'] = targets;
      return json;
    });

    // Apps with a release target come from `pstack app` and need no cross-env / tools scripts.
    const pj = readJson(tree, `${app.root}/project.json`);
    const releaseName = releaseTargetOf(pj.targets ?? {})?.name;
    npmScripts[`serve:${app.name}:${name}`] = releaseName
      ? `nx serve ${app.name} --configuration=${name}`
      : `cross-env NODE_ENV=development nx serve ${app.name} --configuration=${name}`;
    npmScripts[`build:${app.name}:${name}`] = releaseName
      ? `nx run ${app.name}:${releaseName}:${name}`
      : `cross-env NODE_ENV=production node tools/scripts/build.js --project=${app.name} --type=${app.name} --env=${name}`;
    // Ionic apps from `pstack app --type=ionic`: build, then copy into the native project.
    if (releaseName && pj.targets?.['cap-sync']) {
      for (const platform of ['android', 'ios']) {
        npmScripts[
          `build:${app.name}:${name}:${platform}`
        ] = `nx run ${app.name}:${releaseName}:${name} && nx run ${app.name}:cap-sync --platform=${platform}`;
      }
    }
    logger.info(
      `env: ${app.name}: ${plan.newEnvFile} from ${plan.sourceEnvFile}` +
        (derived.placeholders.length ? ` (placeholders: ${derived.placeholders.join(', ')})` : ''),
    );
  }

  // ── Flutter ────────────────────────────────────────────────────────────────
  for (const plan of flutterPlans) {
    const { app } = plan;
    const source = plan.sourceJson
      ? (readJson(tree, plan.sourceJson) as Record<string, unknown>)
      : {};
    const content = plan.sourceJson
      ? deriveFlutterEnv(source, name, apiUrl)
      : { ENV_NAME: name, API_BASE_URL: apiUrl ?? `https://${name}.example.com/api` };
    tree.write(`${app.root}/env/${name}.json`, JSON.stringify(content, null, 2) + '\n');

    if (app.kind === 'plugin') {
      updateJson(tree, `${app.root}/project.json`, (json: Record<string, unknown>) => {
        const targets = (json['targets'] ?? {}) as Record<string, Record<string, unknown>>;
        for (const targetName of ['build-web', 'build-android', 'build-ios']) {
          const target = targets[targetName] as Record<string, unknown> | undefined;
          if (!target) continue;
          const configs = (target['configurations'] ?? {}) as Record<
            string,
            Record<string, unknown>
          >;
          const sourceName = sources
            .map((s) => configurationFor(target, s))
            .find((c): c is string => c !== undefined);
          const conf: Record<string, unknown> = sourceName
            ? JSON.parse(JSON.stringify(configs[sourceName]))
            : {};
          conf['env'] = name;
          if (targetName === 'build-web' && baseHref !== undefined) conf['baseHref'] = baseHref;
          configs[name] = conf;
          target['configurations'] = configs;
        }
        json['targets'] = targets;
        return json;
      });

      npmScripts[`build:${app.name}:${name}:web`] = `nx run ${app.name}:build-web:${name}`;
      npmScripts[`build:${app.name}:${name}:apk`] = `nx run ${app.name}:build-android:${name}`;
      npmScripts[`build:${app.name}:${name}:ios`] = `nx run ${app.name}:build-ios:${name}`;
    } else {
      // run-commands: env is passed at runtime via {args.env} — no project.json patch needed
      npmScripts[
        `build:${app.name}:${name}:web`
      ] = `cross-env NODE_ENV=production nx run ${app.name}:build-web --args="--env=${name}"`;
      npmScripts[
        `build:${app.name}:${name}:apk`
      ] = `cross-env NODE_ENV=production nx run ${app.name}:build-android --args="--env=${name}"`;
      npmScripts[
        `build:${app.name}:${name}:ios`
      ] = `cross-env NODE_ENV=production nx run ${app.name}:build-ios --args="--env=${name}"`;
    }
    logger.info(
      `env: ${app.name}: ${app.root}/env/${name}.json from ${plan.sourceJson ?? 'defaults'}`,
    );
  }

  addNpmScripts(tree, npmScripts, { force: false });
  await formatFiles(tree);
  // After formatting: Prettier must not touch the text around the block.
  refreshLlmBlocks(tree);

  if (placeholders.length > 0) {
    notes.push(
      `Set these before building ${name} (CI variables, or .env.local for local builds): ` +
        `${[...new Set(placeholders)].join(', ')}.`,
    );
  }
  notes.push(`Review the copied values (urls, flags) in the new ${name} files.`);
  for (const n of notes) logger.info(`Note: ${n}`);
}

interface AngularPlan {
  app: AngularApp;
  /** The environment it is copied from. */
  from: string;
  /** No configuration of `from` to copy. */
  noSource: boolean;
  /** The app has a polystack release target (it fills ${…} placeholders). */
  hasRelease: boolean;
  /** Env project of the release target (folder under environments/). */
  envProject: string;
  newEnvFile: string;
  sourceEnvFile: string;
  sourceBuildConfig: string;
  sourceRelease?: string;
  problems: string[];
}

/** The plan from the first source environment the app has (problems of the first when none). */
function planAngularFrom(
  tree: Tree,
  app: AngularApp,
  name: string,
  sources: string[],
): AngularPlan {
  const plans = sources.map((from) => planAngular(tree, app, name, from));
  const usable = plans.find((p) => !p.noSource);
  const plan = usable ?? plans[0];
  if (usable && usable.from !== sources[0]) {
    logger.info(`env: ${app.name} has no ${sources[0]} configuration; copying ${usable.from}.`);
  }
  return plan;
}

/** Where the new Angular environment comes from, and what stands in the way. */
function planAngular(tree: Tree, app: AngularApp, name: string, from: string): AngularPlan {
  const pj = readJson(tree, `${app.root}/project.json`);
  const targets = (pj.targets ?? {}) as Record<string, Record<string, unknown>>;
  const buildConfigs = (targets['build']?.['configurations'] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const release = releaseTargetOf(targets);
  const releaseConfigs = (release?.target['configurations'] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const problems: string[] = [];
  const sourceRelease = release ? configurationFor(release.target, from) : undefined;
  const fromRelease = sourceRelease
    ? (releaseConfigs[sourceRelease]['buildConfiguration'] as string | undefined)
    : undefined;
  const fallback = from === 'prod' ? 'production' : from === 'dev' ? 'development' : from;
  const sourceBuildConfig = [fromRelease, from, fallback].find(
    (c): c is string => typeof c === 'string' && Boolean(buildConfigs[c]),
  );
  const base = `${app.envDir}/${app.baseEnvFile}`;
  let sourceEnvFile = base;
  if (!sourceBuildConfig) {
    problems.push(`${app.name}: no "${from}" configuration to copy (use --from=<env>)`);
  } else {
    const replacements = (buildConfigs[sourceBuildConfig]['fileReplacements'] ?? []) as Array<{
      replace: string;
      with: string;
    }>;
    sourceEnvFile = replacements.find((r) => r.replace === base)?.with ?? base;
    if (!tree.exists(sourceEnvFile)) problems.push(`${app.name}: ${sourceEnvFile} not found`);
  }

  // The release build reads environments/<envProject>/environment.<env>.ts; other builds only
  // need the file next to the one it is copied from.
  const releaseOptions = (release?.target['options'] ?? {}) as Record<string, unknown>;
  const envProject =
    typeof releaseOptions['envProject'] === 'string'
      ? (releaseOptions['envProject'] as string)
      : envProjectOf(app);
  const newEnvFile = release
    ? `environments/${envProject}/environment.${name}.ts`
    : `${sourceEnvFile.slice(0, sourceEnvFile.lastIndexOf('/'))}/${app.baseEnvFile.replace(
        /\.ts$/,
        `.${name}.ts`,
      )}`;
  if (tree.exists(newEnvFile)) problems.push(`${app.name}: ${newEnvFile} already exists`);
  if (buildConfigs[name])
    problems.push(`${app.name}: build configuration "${name}" already exists`);
  if (releaseConfigs[name])
    problems.push(`${app.name}: ${release?.name} configuration "${name}" already exists`);

  return {
    app,
    from,
    noSource: !sourceBuildConfig,
    hasRelease: Boolean(release && release.target['executor'] === POLYSTACK_BUILD_EXECUTOR),
    envProject,
    newEnvFile,
    sourceEnvFile,
    sourceBuildConfig: sourceBuildConfig ?? 'production',
    sourceRelease,
    problems,
  };
}

interface FlutterPlan {
  app: FlutterApp;
  sourceJson?: string;
  problems: string[];
}

function planFlutter(
  tree: Tree,
  app: FlutterApp,
  name: string,
  sources: string[],
  explicit: boolean,
): FlutterPlan {
  const problems: string[] = [];
  const file = `${app.root}/env/${name}.json`;
  if (tree.exists(file)) problems.push(`${app.name}: ${file} already exists`);
  const source = sources.map((s) => `${app.root}/env/${s}.json`).find((f) => tree.exists(f));
  if (!source && explicit)
    problems.push(`${app.name}: ${app.root}/env/${sources[0]}.json not found`);
  if (app.kind === 'plugin') {
    const targets = (readJson(tree, `${app.root}/project.json`).targets ?? {}) as Record<
      string,
      { configurations?: Record<string, Record<string, unknown>> }
    >;
    for (const t of ['build-web', 'build-android', 'build-ios']) {
      const target = targets[t];
      if (!target) continue;
      if (target.configurations?.[name]) {
        problems.push(`${app.name}: ${t} configuration "${name}" already exists`);
      }
      const found = sources.some((s) => configurationFor(target, s) !== undefined);
      if (!found && explicit) {
        problems.push(`${app.name}: ${t} has no "${sources[0]}" configuration to copy`);
      }
    }
  }
  return { app, sourceJson: source, problems };
}

/** The polystack release target (any name), else a target named release. */
function releaseTargetOf(
  targets: Record<string, Record<string, unknown>>,
): { name: string; target: Record<string, unknown> } | undefined {
  const entry =
    Object.entries(targets).find(([, t]) => t?.['executor'] === POLYSTACK_BUILD_EXECUTOR) ??
    (targets['release'] ? ['release', targets['release']] : undefined);
  return entry
    ? { name: entry[0] as string, target: entry[1] as Record<string, unknown> }
    : undefined;
}

/** environments/<project>/… → <project>; otherwise the app name. */
function envProjectOf(app: AngularApp): string {
  const m = /^environments\/([^/]+)/.exec(app.envDir);
  return m ? m[1] : app.name;
}

/** The workspace's env encryption settings (defaults when nx.json has none). */
function workspaceEncryption(tree: Tree): EnvEncryptionConfig {
  const raw = readEnvEncryptionBlock(tree);
  // nx.json, else the legacy keys file, else defaults — as the release build reads them.
  return raw === undefined ? initialEnvEncryption(tree) : normalizeEnvEncryption(raw);
}

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Angular/Ionic apps: identified by a build target that has at least one non-development
 * configuration containing fileReplacements. The replace path tells us the exact env file location.
 */
function detectAngularApps(tree: Tree): AngularApp[] {
  const apps: AngularApp[] = [];

  for (const { root, json: pj } of findProjects(tree, 'apps')) {
    const appName = projectNameOf(root, pj);
    const targets = (pj['targets'] ?? {}) as Record<string, unknown>;
    const buildTarget = targets['build'] as Record<string, unknown> | undefined;
    if (!buildTarget) continue;

    const configs = (buildTarget['configurations'] ?? {}) as Record<string, unknown>;
    for (const [configName, config] of Object.entries(configs)) {
      if (configName === 'development') continue;
      const replacements = (config as Record<string, unknown>)['fileReplacements'] as
        | Array<{ replace: string; with: string }>
        | undefined;
      if (!replacements?.length) continue;

      // The environment file swap (others, e.g. config files, may come first).
      const envSwap =
        replacements.find((r) => /(^|\/)environment[^/]*\.ts$/.test(r.replace)) ?? replacements[0];
      const replacePath = envSwap.replace;
      const lastSlash = replacePath.lastIndexOf('/');
      apps.push({
        name: appName,
        root,
        envDir: replacePath.substring(0, lastSlash),
        baseEnvFile: replacePath.substring(lastSlash + 1),
      });
      break;
    }
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Flutter apps: identified by build-web/build-android/build-ios targets AND an env/ directory.
 * Two executor styles are handled:
 *   - "plugin"       : @mouryaamit/nx-polystack:flutter-build (has configurations blocks)
 *   - "run-commands" : nx:run-commands with flutter-build.js in the command string
 */
function detectFlutterApps(tree: Tree): FlutterApp[] {
  const apps: FlutterApp[] = [];

  for (const { root, json: pj } of findProjects(tree, 'apps')) {
    if (!tree.exists(`${root}/env`)) continue;
    const appName = projectNameOf(root, pj);
    const targets = (pj['targets'] ?? {}) as Record<string, unknown>;

    const flutterTargets = ['build-web', 'build-android', 'build-ios'];

    const pluginMatch = flutterTargets.some((t) => {
      const target = targets[t] as Record<string, unknown> | undefined;
      return (target?.['executor'] as string | undefined)?.includes('flutter-build');
    });

    if (pluginMatch) {
      apps.push({ kind: 'plugin', name: appName, root });
      continue;
    }

    const runCommandsMatch = flutterTargets.some((t) => {
      const target = targets[t] as Record<string, unknown> | undefined;
      const cmd = (target?.['options'] as Record<string, unknown> | undefined)?.['command'];
      return typeof cmd === 'string' && cmd.includes('flutter-build');
    });

    if (runCommandsMatch) {
      apps.push({ kind: 'run-commands', name: appName, root });
    }
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** project.json `name`, else the folder name. */
function projectNameOf(root: string, pj: Record<string, unknown>): string {
  return typeof pj['name'] === 'string' ? pj['name'] : root.slice(root.lastIndexOf('/') + 1);
}

/**
 * New env configuration: a copy of the --from env's build configuration (so budgets and
 * optimisation match the app) with this env's file swapped in. Falls back to defaults.
 */
function angularBuildConfig(app: AngularApp, newEnvFile: string, production?: unknown): object {
  const envReplace = `${app.envDir}/${app.baseEnvFile}`;
  const envEntry = { replace: envReplace, with: newEnvFile };
  if (production && typeof production === 'object') {
    const copy = JSON.parse(JSON.stringify(production)) as Record<string, unknown>;
    // Keep production's other replacements; swap (or add) only the environment file.
    const existing = (copy['fileReplacements'] ?? []) as Array<{ replace: string; with: string }>;
    const others = existing.filter((r) => r.replace !== envReplace);
    return { ...copy, fileReplacements: [envEntry, ...others] };
  }
  return {
    budgets: [
      { type: 'initial', maximumWarning: '3mb', maximumError: '15mb' },
      { type: 'anyComponentStyle', maximumWarning: '6kb', maximumError: '10kb' },
    ],
    fileReplacements: [envEntry],
    outputHashing: 'all',
    optimization: true,
    sourceMap: false,
    namedChunks: false,
    extractLicenses: true,
    buildOptimizer: true,
  };
}
