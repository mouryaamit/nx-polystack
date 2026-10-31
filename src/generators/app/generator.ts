import { spawnSync } from 'child_process';
import * as path from 'path';

import {
  GeneratorCallback,
  Tree,
  generateFiles,
  names,
  offsetFromRoot,
  formatFiles,
  logger,
  readJson,
} from '@nx/devkit';

import {
  ANGULAR_VERSION,
  ensureAngularDependencies,
  ionicAngularImport,
  ionicStandaloneImport,
  PROVIDE_HTTP_CLIENT_MAJOR,
  STANDALONE_FALSE_MAJOR,
  workspaceGeneratorMajor,
  workspaceGeneratorVersions,
  ZONE_PROVIDER_MAJOR,
  assertStandaloneSupported,
  POLYFILLS_ARRAY_MAJOR,
} from '../../lib/utils/angular-deps';
import { resolveAngularStyle } from '../../lib/utils/angular-style';
import {
  angularProjectTargets,
  cleanTarget,
  ENV_LAYOUTS,
  EnvLayout,
  ionicProjectTargets,
  PER_ENV_ROOT_FILE,
  RELEASE_CONFIGURATIONS,
} from '../../lib/utils/angular-project';
import { parseAllowlist } from '../../lib/csp/allowlist';
import { renderFlutterHtaccess, renderHtaccess, renderNginx } from '../../lib/csp/render';
import { htaccessSourcePath } from '../../lib/release/htaccess';
import { baseHrefTarget, checkBaseHref, setBaseHref } from '../../lib/utils/base-href';
import { appRoot, assertDirOutsideProjects, parseDir, upTo } from '../../lib/utils/app-dir';
import {
  addMissingDependencies,
  declaredVersion,
  ensureReleaseHardeningDependencies,
} from '../../lib/utils/dependencies';
import { ensureEnvAlias, envAliasImport } from '../../lib/utils/env-alias';
import { generateAngularEnvFiles, generateFlutterEnvFiles } from '../../lib/utils/env-files';
import { refreshLlmBlocks, workspaceProjectNames } from '../../lib/utils/llm-block';
import { addNpmScripts } from '../../lib/utils/npm-scripts';
import { flutterWebFiles } from '../../lib/utils/flutter-web';
import { setProjectTags } from '../../lib/utils/nx-targets';
import { analyzeTarget } from '../../lib/utils/quality';
import { addExifScripts } from '../../lib/utils/exif-checks';
import { nextFreePort, portProblem, usedServePorts } from '../../lib/utils/serve-port';
import { ensureSharedLibs, wireSharedLibs } from '../../lib/utils/shared-libs';
import { addTsPath } from '../../lib/utils/ts-paths';

import { appFrom, appFromReport, defaultAppId } from './from';
import { AppGeneratorSchema } from './schema.d';

const splitList = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export default async function appGenerator(
  tree: Tree,
  options: AppGeneratorSchema,
): Promise<GeneratorCallback | undefined> {
  if (options.from !== undefined) {
    const result = appFrom(tree, {
      from: options.from,
      name: options.name,
      dir: options.dir,
      port: options.port,
      baseHref: options.baseHref === 'none' ? null : options.baseHref,
      appId: options.appId,
      envs: typeof options.envs === 'string' ? splitList(options.envs) : options.envs,
      csp: options.csp,
      tags: options.tags && options.tags.length > 0 ? options.tags : undefined,
    });
    logger.info(appFromReport(result));
    return undefined;
  }
  const {
    name,
    type = 'flutter',
    i18n = [],
    push = 'none',
    deeplink,
    tags = [],
    cspConnectSrc,
  } = options;
  const projectName = name;

  if (type !== 'flutter' && type !== 'angular' && type !== 'ionic') {
    throw new Error(
      `app generator: --type="${type}" is not supported. Supported types: flutter, angular, ionic.`,
    );
  }
  if ((options.standalone || options.module) && type === 'flutter') {
    throw new Error('app generator: --standalone and --module are for Angular and Ionic apps.');
  }
  if (options.baseHref !== undefined) {
    try {
      checkBaseHref(options.baseHref);
    } catch (err) {
      throw new Error(`app generator: ${(err as Error).message}`);
    }
  }
  const dir = parseDir(options.dir, 'app generator');
  const projectPath = appRoot(projectName, dir);
  const up = upTo(projectPath);
  const appId = options.appId ?? defaultAppId(projectName);
  if (type === 'ionic' && !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(appId)) {
    throw new Error(
      `app generator: --appId="${appId}" is not a valid Capacitor appId (reverse-DNS, e.g. com.acme.app).`,
    );
  }

  const envLayout: EnvLayout = options.envLayout ?? 'default';
  if (!ENV_LAYOUTS.includes(envLayout)) {
    throw new Error(
      `app generator: --envLayout="${envLayout}" is not supported. Use ${ENV_LAYOUTS.join(
        ' or ',
      )}.`,
    );
  }
  if (options.port !== undefined) {
    const problem = portProblem(options.port);
    if (problem) throw new Error(`app generator: ${problem}.`);
  }

  if (dir) assertDirOutsideProjects(tree, dir, 'app generator');
  if (tree.exists(projectPath)) {
    throw new Error(
      `app generator: "${projectPath}" already exists. Pick another --name or --dir.`,
    );
  }
  if (workspaceProjectNames(tree).includes(projectName) || rootProjectName(tree) === projectName) {
    throw new Error(
      `app generator: a project named "${projectName}" already exists. Pick another --name.`,
    );
  }

  const used = usedServePorts(tree);
  if (options.port !== undefined) {
    const owner = used.find((u) => u.port === options.port);
    if (owner) {
      throw new Error(
        `app generator: port ${options.port} is used by ${owner.project}` +
          `${owner.explicit ? '' : ' (no port set: the 4200 default)'}. Pick another --port.`,
      );
    }
  }
  const port = options.port ?? nextFreePort(used.map((u) => u.port));

  const n = names(projectName);
  const className = n.className;
  const projectSnake = projectName.replace(/-/g, '_');
  const title = n.className.replace(/([A-Z])/g, ' $1').trim();

  let installTask: GeneratorCallback | undefined;

  if (type === 'angular' || type === 'ionic') {
    const major = workspaceGeneratorMajor(tree);
    const style = resolveAngularStyle(
      tree,
      { standalone: options.standalone, module: options.module },
      'app generator',
    );
    const standalone = style === 'standalone';
    if (standalone) assertStandaloneSupported(major, 'app generator');
    // Angular 14: zone.js from src/polyfills.ts, ES2020.
    const polyfillsFile = major < POLYFILLS_ARRAY_MAJOR;
    const vars = {
      name: projectName,
      // Capacitor for the workspace's Angular (5 on 15, 6 on 16–17, 7 on 18–20, 8 on 21); Angular itself is added below.
      capacitorVersion: workspaceGeneratorVersions(tree).capacitor,
      provideHttp: workspaceGeneratorMajor(tree) >= PROVIDE_HTTP_CLIENT_MAJOR,
      // NgModule declarations on 19+ say standalone: false; standalone components on 15–18 say true.
      standaloneFalse: !standalone && major >= STANDALONE_FALSE_MAJOR,
      standaloneTrue: standalone && major < STANDALONE_FALSE_MAJOR,
      standalone,
      ionic: type === 'ionic',
      // ApplicationConfig moved from @angular/platform-browser to @angular/core in Angular 16.
      applicationConfigFromCore: major >= 16,
      zoneProviders: major >= ZONE_PROVIDER_MAJOR,
      polyfillsFile,
      tsTarget: polyfillsFile ? 'es2020' : 'es2022',
      ionicImport: ionicAngularImport(major),
      ionicStandaloneImport: ionicStandaloneImport(major),
      className,
      title,
      appId,
      cspConnectSrc: cspConnectSrc ?? '',
      root: projectPath,
      up,
      envImport: envImportSpecifier(
        tree,
        envLayout === 'per-env'
          ? PER_ENV_ROOT_FILE.replace(/\.ts$/, '')
          : `environments/${projectName}/environment`,
        `${projectPath}/src`,
      ),
      template: '',
    };
    generateFiles(tree, path.join(__dirname, 'files', 'angular'), projectPath, vars);
    // NgModule apps: AppModule, AppRoutingModule, bootstrapModule; standalone apps: app.config.ts,
    // app.routes.ts, bootstrapApplication.
    generateFiles(tree, path.join(__dirname, 'files', `angular-${style}`), projectPath, vars);
    if (polyfillsFile) {
      tree.write(
        `${projectPath}/src/polyfills.ts`,
        "// Loaded before the app (the build's polyfills option). Zone.js is required by Angular.\nimport 'zone.js';\n",
      );
    }
    if (type === 'ionic') {
      // Overlays the Angular files: <ion-app>, Ionic styles, Capacitor config (and IonicModule).
      generateFiles(tree, path.join(__dirname, 'files', 'ionic'), projectPath, vars);
      if (!standalone) {
        generateFiles(tree, path.join(__dirname, 'files', 'ionic-module'), projectPath, vars);
      }
    }

    // Server config rendered from the allowlist (pstack csp re-renders it after edits).
    let allowlist;
    try {
      allowlist = parseAllowlist(cspConnectSrc ? { 'connect-src': [cspConnectSrc] } : {});
    } catch (err) {
      throw new Error(`app generator: --cspConnectSrc: ${(err as Error).message}`);
    }
    // One .htaccess per env, next to the env files; the release build copies the env's own.
    for (const env of releaseEnvNames()) {
      tree.write(htaccessSourcePath(projectName, env), renderHtaccess(projectName, allowlist));
    }
    tree.write(`${projectPath}/server/nginx.conf`, renderNginx(projectName, allowlist));

    generateAngularEnvFiles(tree, projectName, envLayout);

    const targetOptions = { envLayout, port, angularMajor: workspaceGeneratorMajor(tree) };
    const targets =
      type === 'ionic'
        ? ionicProjectTargets(projectName, projectPath, targetOptions)
        : angularProjectTargets(projectName, projectPath, targetOptions);
    const projectJson = buildAngularProjectJson(projectName, projectPath, targets) as Record<
      string,
      unknown
    >;
    // Shared assets and styles (created on first use) are wired into every new web app.
    const shared = ensureSharedLibs(tree);
    wireSharedLibs(projectJson, targets['build'] as { options?: Record<string, unknown> }, shared);
    for (const note of shared.notes) logger.info(note);
    tree.write(`${projectPath}/project.json`, JSON.stringify(projectJson, null, 2) + '\n');

    const platform = type === 'ionic' ? 'platform:mobile' : 'platform:web';
    setProjectTags(tree, projectPath, ['scope:app', 'type:app', platform, ...tags]);

    addNpmScripts(
      tree,
      type === 'ionic' ? buildIonicNpmScripts(projectName) : buildAngularNpmScripts(projectName),
      { force: false },
    );

    addTsPath(tree, `@mouryaamit/${projectName}`, `${projectPath}/src`);

    // Both only edit package.json; one install task covers them.
    const hardeningTask = ensureReleaseHardeningDependencies(tree);
    installTask = ensureAngularDependencies(tree, { includeRuntime: true }) ?? hardeningTask;
    if (type === 'ionic') {
      const core = declaredVersion(tree, '@angular/core') ?? ANGULAR_VERSION;
      // @angular/forms is a peer of @ionic/angular; match the installed Angular.
      const ionicTask = addMissingDependencies(
        tree,
        { '@ionic/angular': workspaceGeneratorVersions(tree).ionicAngular, '@angular/forms': core },
        {},
      );
      const rootTask = installTask;
      const appDir = path.join(tree.root, projectPath);
      installTask = async () => {
        if (rootTask) await rootTask();
        else if (ionicTask) await ionicTask();
        // The app's own Capacitor packages (per-app package.json).
        const r = spawnSync('npm', ['install'], {
          cwd: appDir,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
        if (r.error || r.status !== 0) {
          throw new Error(
            `npm install failed in ${projectPath} (Capacitor packages). Run "npm install" there; ` +
              'the cap-* targets also install them on first use.',
          );
        }
      };
    }
  } else {
    generateFiles(tree, path.join(__dirname, 'files', 'flutter'), projectPath, {
      name: projectName,
      projectSnake,
      className,
      title,
      i18n,
      push,
      deeplink,
      template: '',
      offsetFromRoot: offsetFromRoot(projectPath),
    });

    for (const [file, content] of Object.entries(flutterWebFiles(projectName))) {
      tree.write(`${projectPath}/${file}`, content);
    }

    generateFlutterEnvFiles(tree, projectName);
    for (const env of ['dev', 'uat', 'prod']) {
      tree.write(htaccessSourcePath(projectName, env), renderFlutterHtaccess(projectName, env));
    }

    tree.write(
      `${projectPath}/project.json`,
      JSON.stringify(buildProjectJson(projectName, { root: projectPath, port }), null, 2) + '\n',
    );

    setProjectTags(tree, projectPath, ['scope:app', 'type:app', 'platform:flutter', ...tags]);

    addNpmScripts(tree, buildNpmScripts(projectName), { force: false });

    if (i18n.length > 0) {
      scaffoldL10n(tree, projectPath, i18n);
    }

    if (push === 'fcm') {
      scaffoldFcm(tree, projectPath, projectSnake);
    }

    if (deeplink) {
      scaffoldDeeplink(tree, projectName, deeplink);
    }
  }

  if (type !== 'flutter') {
    // Flutter's script set (buildNpmScripts) already has it.
    addNpmScripts(
      tree,
      { [`clean:${projectName}`]: `nx run ${projectName}:clean` },
      { force: false },
    );
  }

  if (options.baseHref !== undefined) {
    const pj = `${projectPath}/project.json`;
    const json = readJson(tree, pj);
    const found = baseHrefTarget(json);
    if (found) {
      const configs = ['uat', 'prod'].filter((c) => found.target.configurations?.[c]);
      setBaseHref(found.target, configs, options.baseHref);
      tree.write(pj, JSON.stringify(json, null, 2) + '\n');
    }
  }

  // assets:strip-exif / assets:check-exif (pstack assets strip-exif) when the workspace has none.
  addExifScripts(tree);

  await formatFiles(tree);
  // After formatting: Prettier must not touch the text around the block.
  refreshLlmBlocks(tree);
  return installTask;
}

/** project.json for a Flutter app (also used by :migrate). */
export interface FlutterProjectOptions {
  /** The FlutterFlow export target and npm script (default true; :migrate leaves them out). */
  exportTarget?: boolean;
  /** Web dev-server port of the serve target (default: the executor's 4200). */
  port?: number;
  /** Project root (default apps/<name>); :migrate keeps the source root. */
  root?: string;
  /** false: build-web makes no .htaccess (:migrate; the source app had none). Default: on. */
  htaccess?: boolean;
}

export function buildProjectJson(name: string, opts: FlutterProjectOptions = {}): object {
  const executor = '@mouryaamit/nx-polystack';
  const root = opts.root ?? `apps/${name}`;
  const depth = root.split('/').length;
  return {
    name,
    $schema: `${'../'.repeat(depth)}node_modules/nx/schemas/project-schema.json`,
    projectType: 'application',
    sourceRoot: `${root}/lib`,
    tags: ['scope:app', 'type:app', 'platform:flutter'],
    targets: {
      serve: {
        executor: `${executor}:flutter-build`,
        options: {
          target: 'web',
          serve: true,
          ...(opts.port !== undefined ? { port: opts.port } : {}),
        },
      },
      'build-web': {
        executor: `${executor}:flutter-build`,
        options: {
          target: 'web',
          dist: `dist/${root}/web`,
          ...(opts.htaccess === false ? { htaccess: false } : {}),
        },
        configurations: {
          dev: { env: 'dev' },
          uat: { env: 'uat' },
          prod: { env: 'prod' },
        },
      },
      'build-android': {
        executor: `${executor}:flutter-build`,
        options: { target: 'apk' },
        configurations: {
          dev: { env: 'dev' },
          uat: { env: 'uat' },
          prod: { env: 'prod' },
        },
      },
      'build-ios': {
        executor: `${executor}:flutter-build`,
        options: { target: 'ios' },
        configurations: {
          dev: { env: 'dev' },
          uat: { env: 'uat' },
          prod: { env: 'prod' },
        },
      },
      ...(opts.exportTarget === false
        ? {}
        : {
            export: {
              executor: `${executor}:flutter-export`,
              options: { dest: root },
            },
          }),
      analyze: analyzeTarget(root),
      clean: cleanTarget(root, { flutter: true, name }),
    },
  };
}

function buildAngularProjectJson(
  name: string,
  root: string,
  targets: Record<string, unknown>,
): object {
  return {
    name,
    $schema: `${upTo(root)}node_modules/nx/schemas/project-schema.json`,
    projectType: 'application',
    sourceRoot: `${root}/src`,
    prefix: 'app',
    tags: [],
    targets,
  };
}

/** Name of a root project.json (standalone layout), if there is a readable one. */
function rootProjectName(tree: Tree): string | undefined {
  if (!tree.exists('project.json')) return undefined;
  try {
    return readJson(tree, 'project.json').name;
  } catch {
    return undefined;
  }
}

function buildIonicNpmScripts(name: string): Record<string, string> {
  const scripts = buildAngularNpmScripts(name);
  for (const env of ['dev', 'uat', 'prod']) {
    for (const platform of ['android', 'ios']) {
      scripts[
        `build:${name}:${env}:${platform}`
      ] = `nx run ${name}:release:${env} && nx run ${name}:cap-sync --platform=${platform}`;
    }
  }
  for (const platform of ['android', 'ios']) {
    scripts[`open:${name}:${platform}`] = `nx run ${name}:cap-open --platform=${platform}`;
  }
  return scripts;
}

function buildAngularNpmScripts(name: string): Record<string, string> {
  return {
    [`serve:${name}`]: `nx serve ${name}`,
    [`build:${name}:dev`]: `nx run ${name}:release:dev`,
    [`build:${name}:uat`]: `nx run ${name}:release:uat`,
    [`build:${name}:prod`]: `nx run ${name}:release:prod`,
    [`build:${name}:prod:secure`]: `nx run ${name}:release:prod --secure`,
    [`build:${name}:prod:secure:sri`]: `nx run ${name}:release:prod --secure --sri`,
  };
}

/** Root npm scripts for a Flutter app (also used by :migrate). */
export function buildNpmScripts(
  name: string,
  opts: FlutterProjectOptions = {},
): Record<string, string> {
  const scripts: Record<string, string> = {
    [`serve:${name}`]: `nx serve ${name}`,
    [`build:${name}:dev:web`]: `nx run ${name}:build-web:dev`,
    [`build:${name}:uat:web`]: `nx run ${name}:build-web:uat`,
    [`build:${name}:prod:web`]: `nx run ${name}:build-web:prod`,
    [`build:${name}:dev:apk`]: `nx run ${name}:build-android:dev`,
    [`build:${name}:uat:apk`]: `nx run ${name}:build-android:uat`,
    [`build:${name}:prod:apk`]: `nx run ${name}:build-android:prod`,
    [`build:${name}:dev:ios`]: `nx run ${name}:build-ios:dev`,
    [`build:${name}:uat:ios`]: `nx run ${name}:build-ios:uat`,
    [`build:${name}:prod:ios`]: `nx run ${name}:build-ios:prod`,
    [`clean:${name}`]: `nx run ${name}:clean`,
  };
  if (opts.exportTarget !== false) scripts[`export:${name}`] = `nx export ${name}`;
  return scripts;
}

function scaffoldL10n(tree: Tree, projectPath: string, locales: string[]): void {
  const l10nDir = `${projectPath}/lib/l10n`;
  for (const locale of locales) {
    tree.write(
      `${l10nDir}/app_${locale}.arb`,
      JSON.stringify({ '@@locale': locale, appTitle: 'App' }, null, 2) + '\n',
    );
  }
  tree.write(
    `${projectPath}/l10n.yaml`,
    `arb-dir: lib/l10n\ntemplate-arb-file: app_${locales[0]}.arb\noutput-localization-file: app_localizations.dart\n`,
  );
}

function scaffoldFcm(tree: Tree, projectPath: string, _projectSnake: string): void {
  tree.write(
    `${projectPath}/lib/notifications.dart`,
    `import 'package:firebase_messaging/firebase_messaging.dart';\n\nFuture<void> initFcm() async {\n  final messaging = FirebaseMessaging.instance;\n  await messaging.requestPermission();\n  final token = await messaging.getToken();\n  // ignore: avoid_print\n  print('FCM token: $token');\n}\n`,
  );
}

function scaffoldDeeplink(tree: Tree, projectName: string, deeplink: string): void {
  const domain = new URL(deeplink).hostname;
  const packageName = `com.example.${projectName.replace(/-/g, '_')}`;
  const assetlinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: ['REPLACE_WITH_CERT_SHA256'],
      },
    },
  ];
  const appleAsa = {
    applinks: {
      apps: [],
      details: [{ appID: `TEAMID.${packageName}`, paths: ['*'] }],
    },
  };
  for (const env of ['dev', 'uat', 'prod']) {
    const dest = `libs/well-known/${env}/.well-known`;
    tree.write(`${dest}/assetlinks.json`, JSON.stringify(assetlinks, null, 2) + '\n');
    tree.write(`${dest}/apple-app-site-association`, JSON.stringify(appleAsa, null, 2) + '\n');
  }
  // Write a README stub so developers know which domain to host these files under
  tree.write(
    `libs/well-known/README.md`,
    `# Deep-link well-known files\n\nHost the files in each env folder at \`https://${domain}/.well-known/\`.\nReplace \`TEAMID\` and \`REPLACE_WITH_CERT_SHA256\` with real values before publishing.\n`,
  );
}

/** Env names of a new app's release configurations (dev, uat, prod). */
function releaseEnvNames(): string[] {
  return Object.values(RELEASE_CONFIGURATIONS).map((c) => c.env.toLowerCase());
}

/**
 * How main.ts imports its env file: through the `@env/*` alias (added to tsconfig when missing;
 * Nx 18+ refuses relative imports of the root environments/ folder), or relatively when the
 * workspace maps `@env/*` to something else.
 */
function envImportSpecifier(tree: Tree, envFile: string, fromDir: string): string {
  const state = ensureEnvAlias(tree);
  if (state === 'present' || state === 'added') {
    return envAliasImport(envFile);
  }
  const rel = path.posix.relative(fromDir, envFile);
  return rel.startsWith('.') ? rel : `./${rel}`;
}
