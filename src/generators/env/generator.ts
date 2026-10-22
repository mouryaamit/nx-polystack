import { Tree, formatFiles, logger, readJson, updateJson } from '@nx/devkit';

import { parseAllowlist, serializeAllowlist } from '../../lib/csp/allowlist';
import { EnvEncryptionConfig, normalizeEnvEncryption } from '../../lib/env-encryption/config';
import { normalizeHosts } from '../../lib/env-encryption/domains';
import { initialEnvEncryption, readEnvEncryptionBlock } from '../../lib/env-encryption/workspace';
import { deriveEnvFile, deriveFlutterEnv } from '../../lib/env/derive';
import { htaccessSourcePath } from '../../lib/release/htaccess';
import { configurationFor } from '../../lib/release/plan';
import { POLYSTACK_BUILD_EXECUTOR, RELEASE_HARDENING } from '../../lib/utils/angular-project';
import { checkBaseHref } from '../../lib/utils/base-href';
import { ENV_ROOT, flutterEnvFile } from '../../lib/utils/env-files';
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
  /** Folder under environments/ holding environment.<env>.json and htaccess.<env>. */
  envProject: string;
  /** build-web copies htaccess.<env> into the web build (its htaccess option is not false). */
  htaccess: boolean;
  /** The env files are still in <root>/env/ (pstack update moves them). */
  staleEnvDir?: string;
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
        'Flutter apps need build-web/build-android/build-ios targets and their env files ' +
        '(environments/<app>/environment.<env>.json).',
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
  for (const p of [...angularPlans, ...flutterPlans]) {
    for (const f of [p.newEnvFile, p.htaccess?.file]) {
      if (f) byFile.set(f, [...(byFile.get(f) ?? []), p.app.name]);
    }
  }
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
    copyHtaccess(tree, plan);
    if (plan.htaccess) {
      const note = copyCspEnv(tree, `${app.root}/csp-allowlist.json`, name);
      if (note) notes.push(`${app.name}: ${note}`);
    }
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
        (plan.htaccess ? `, ${plan.htaccess.file} from ${plan.htaccess.source}` : '') +
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
    tree.write(plan.newEnvFile, JSON.stringify(content, null, 2) + '\n');
    copyHtaccess(tree, plan);

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
    logger.info(`env: ${app.name}: ${plan.newEnvFile} from ${plan.sourceJson ?? 'defaults'}`);
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
  /** htaccess.<name> copied from htaccess.prod (release builds with htaccess on). */
  htaccess?: HtaccessPlan;
  problems: string[];
}

interface HtaccessPlan {
  source: string;
  file: string;
}

/**
 * A new env's .htaccess for a build that copies one: environments/<envProject>/htaccess.<name>,
 * copied from htaccess.prod (which must exist). Problems when the new file exists already.
 */
function planHtaccess(
  tree: Tree,
  appName: string,
  envProject: string,
  name: string,
  problems: string[],
): HtaccessPlan {
  const source = htaccessSourcePath(envProject, 'prod');
  const file = htaccessSourcePath(envProject, name);
  if (!tree.exists(source)) {
    problems.push(
      `${appName}: ${source} not found; a new env's .htaccess is copied from it ` +
        `(pstack csp --app=${appName} writes every env's file, or set "htaccess": false on the release target)`,
    );
  }
  if (tree.exists(file)) problems.push(`${appName}: ${file} already exists`);
  return { source, file };
}

function copyHtaccess(tree: Tree, plan: { htaccess?: HtaccessPlan }): void {
  if (plan.htaccess) tree.write(plan.htaccess.file, tree.read(plan.htaccess.source) as Buffer);
}

/**
 * The prod sources of csp-allowlist.json ("envs.prod") for the new env too, as its htaccess is
 * a copy of htaccess.prod: pstack csp then renders the same file. Returns a note when copied.
 */
function copyCspEnv(tree: Tree, file: string, name: string): string | undefined {
  const text = tree.read(file, 'utf-8');
  if (text === null) return undefined;
  let allowlist;
  try {
    allowlist = parseAllowlist(JSON.parse(text));
  } catch {
    return `${file} could not be read; its envs.prod sources (if any) were not copied to envs.${name}`;
  }
  const prod = allowlist.envs?.['prod'];
  if (!prod || allowlist.envs?.[name]) return undefined;
  allowlist.envs = { ...allowlist.envs, [name]: JSON.parse(JSON.stringify(prod)) };
  tree.write(file, serializeAllowlist(allowlist));
  return `${file}: envs.${name} copied from envs.prod (the CSP sources only prod adds)`;
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
  const hasRelease = Boolean(release && release.target['executor'] === POLYSTACK_BUILD_EXECUTOR);
  const htaccess =
    hasRelease && releaseOptions['htaccess'] !== false
      ? planHtaccess(tree, app.name, envProject, name, problems)
      : undefined;

  return {
    app,
    from,
    noSource: !sourceBuildConfig,
    hasRelease,
    envProject,
    newEnvFile,
    sourceEnvFile,
    sourceBuildConfig: sourceBuildConfig ?? 'production',
    sourceRelease,
    htaccess,
    problems,
  };
}

interface FlutterPlan {
  app: FlutterApp;
  newEnvFile: string;
  sourceJson?: string;
  htaccess?: HtaccessPlan;
  problems: string[];
}

/** A Flutter app's env JSON: environments/<envProject>/environment.<env>.json (plugin apps), or the
 * run-commands script's <root>/env/<env>.json. */
function flutterEnvPath(app: FlutterApp, env: string): string {
  return app.kind === 'plugin'
    ? flutterEnvFile(app.envProject, env)
    : `${app.root}/env/${env}.json`;
}

function planFlutter(
  tree: Tree,
  app: FlutterApp,
  name: string,
  sources: string[],
  explicit: boolean,
): FlutterPlan {
  const problems: string[] = [];
  const file = flutterEnvPath(app, name);
  if (tree.exists(file)) problems.push(`${app.name}: ${file} already exists`);
  const source = sources.map((s) => flutterEnvPath(app, s)).find((f) => tree.exists(f));
  if (!source && explicit)
    problems.push(`${app.name}: ${flutterEnvPath(app, sources[0])} not found`);
  let htaccess: HtaccessPlan | undefined;
  if (app.kind === 'plugin' && app.staleEnvDir) {
    problems.push(
      `${app.name}: its env files are still in ${app.staleEnvDir}/; ` +
        `pstack update moves them to ${ENV_ROOT}/${app.envProject}/`,
    );
    return { app, newEnvFile: file, problems };
  }
  if (app.kind === 'plugin') {
    if (app.htaccess) htaccess = planHtaccess(tree, app.name, app.envProject, name, problems);
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
  return { app, newEnvFile: file, sourceJson: source, htaccess, problems };
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
 * Flutter apps: identified by build-web/build-android/build-ios targets and their env files.
 * Two executor styles are handled:
 *   - "plugin"       : @mouryaamit/nx-polystack:flutter-build (has configurations blocks); env files
 *                      in environments/<envProject>/ (build-web's envProject, else the app name)
 *   - "run-commands" : nx:run-commands with flutter-build.js in the command string; env files in
 *                      <root>/env/
 */
function detectFlutterApps(tree: Tree): FlutterApp[] {
  const apps: FlutterApp[] = [];

  for (const { root, json: pj } of findProjects(tree, 'apps')) {
    const appName = projectNameOf(root, pj);
    const targets = (pj['targets'] ?? {}) as Record<string, unknown>;

    const flutterTargets = ['build-web', 'build-android', 'build-ios'];

    const pluginMatch = flutterTargets.some((t) => {
      const target = targets[t] as Record<string, unknown> | undefined;
      return (target?.['executor'] as string | undefined)?.includes('flutter-build');
    });

    if (pluginMatch) {
      const web = targets['build-web'] as Record<string, unknown> | undefined;
      const webOptions = (web?.['options'] ?? {}) as Record<string, unknown>;
      const envProject =
        typeof webOptions['envProject'] === 'string'
          ? (webOptions['envProject'] as string)
          : appName;
      const oldEnvDir = `${root}/env`;
      const staleEnvDir =
        !tree.exists(`${ENV_ROOT}/${envProject}`) && tree.exists(oldEnvDir) ? oldEnvDir : undefined;
      if (!staleEnvDir && !tree.exists(`${ENV_ROOT}/${envProject}`)) continue;
      apps.push({
        kind: 'plugin',
        name: appName,
        root,
        envProject,
        htaccess: Boolean(web) && webOptions['htaccess'] !== false,
        staleEnvDir,
      });
      continue;
    }

    const runCommandsMatch = flutterTargets.some((t) => {
      const target = targets[t] as Record<string, unknown> | undefined;
      const cmd = (target?.['options'] as Record<string, unknown> | undefined)?.['command'];
      return typeof cmd === 'string' && cmd.includes('flutter-build');
    });

    if (runCommandsMatch && tree.exists(`${root}/env`)) {
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
