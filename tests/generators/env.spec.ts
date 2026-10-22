import { Tree, readJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import appGenerator from '../../src/generators/app/generator';
import envGenerator from '../../src/generators/env/generator';

// Minimal Angular project.json shape (mirrors apps/web/project.json)
const angularProjectJson = (name: string) => ({
  name,
  projectType: 'application',
  targets: {
    build: {
      executor: '@angular-devkit/build-angular:browser',
      configurations: {
        production: {
          fileReplacements: [
            {
              replace: `environments/${name}/environment.ts`,
              with: `environments/${name}/environment.prod.ts`,
            },
          ],
          optimization: true,
          sourceMap: false,
        },
        uat: {
          fileReplacements: [
            {
              replace: `environments/${name}/environment.ts`,
              with: `environments/${name}/environment.uat.ts`,
            },
          ],
          optimization: true,
          sourceMap: false,
        },
        development: { optimization: false, sourceMap: true },
      },
    },
    serve: {
      executor: '@angular-devkit/build-angular:dev-server',
      configurations: {
        production: { browserTarget: `${name}:build:production` },
        uat: { browserTarget: `${name}:build:uat` },
        development: { browserTarget: `${name}:build:development` },
      },
    },
  },
});

// Flutter app using nx:run-commands (base-nx-project style)
const flutterRunCommandsProjectJson = (name: string) => ({
  name,
  projectType: 'application',
  targets: {
    'build-web': {
      executor: 'nx:run-commands',
      options: {
        command: `node tools/scripts/flutter/flutter-build.js --project=${name} --target=web --env={args.env}`,
      },
    },
    'build-android': {
      executor: 'nx:run-commands',
      options: {
        command: `node tools/scripts/flutter/flutter-build.js --project=${name} --target=apk --env={args.env}`,
      },
    },
    'build-ios': {
      executor: 'nx:run-commands',
      options: {
        command: `node tools/scripts/flutter/flutter-build.js --project=${name} --target=ios --env={args.env}`,
      },
    },
  },
});

// Flutter app using @mouryaamit/nx-polystack:flutter-build (EFL / plugin style)
const flutterPluginProjectJson = (name: string) => ({
  name,
  projectType: 'application',
  tags: ['scope:app', 'type:app', 'platform:flutter'],
  targets: {
    'build-web': {
      executor: '@mouryaamit/nx-polystack:flutter-build',
      options: { target: 'web' },
      configurations: { dev: { env: 'dev' }, uat: { env: 'uat' }, prod: { env: 'prod' } },
    },
    'build-android': {
      executor: '@mouryaamit/nx-polystack:flutter-build',
      options: { target: 'apk' },
      configurations: { dev: { env: 'dev' }, uat: { env: 'uat' }, prod: { env: 'prod' } },
    },
    'build-ios': {
      executor: '@mouryaamit/nx-polystack:flutter-build',
      options: { target: 'ios' },
      configurations: { dev: { env: 'dev' }, uat: { env: 'uat' }, prod: { env: 'prod' } },
    },
  },
});

function seedWorkspace(tree: Tree): void {
  tree.write('package.json', JSON.stringify({ scripts: {} }));

  // Angular apps
  for (const app of ['web', 'mobile']) {
    tree.write(
      `environments/${app}/environment.ts`,
      `export const environment = { production: false, envName: 'dev' };\n`,
    );
    tree.write(
      `environments/${app}/environment.uat.ts`,
      `export const environment = { production: false, envName: 'uat', apiBaseUrl: 'https://uat.example.com/api', password: 'uat-pass' };\n`,
    );
    tree.write(
      `environments/${app}/environment.prod.ts`,
      `export const environment = { production: true, envName: 'prod' };\n`,
    );
    tree.write(`apps/${app}/project.json`, JSON.stringify(angularProjectJson(app)));
  }

  // Flutter run-commands app (base-nx-project style)
  tree.write(
    'apps/flutter-app/project.json',
    JSON.stringify(flutterRunCommandsProjectJson('flutter-app')),
  );
  tree.write(
    'apps/flutter-app/env/dev.json',
    JSON.stringify({ ENV_NAME: 'dev', API_BASE_URL: 'https://dev.example.com/api' }),
  );
  tree.write(
    'apps/flutter-app/env/uat.json',
    JSON.stringify({ ENV_NAME: 'uat', API_BASE_URL: 'https://uat.example.com/api' }),
  );

  // Flutter plugin-executor app (EFL style)
  tree.write(
    'apps/plugin-flutter/project.json',
    JSON.stringify(flutterPluginProjectJson('plugin-flutter')),
  );
  tree.write(
    'environments/plugin-flutter/environment.dev.json',
    JSON.stringify({ ENV_NAME: 'dev', API_BASE_URL: 'https://dev.example.com/api' }),
  );
  tree.write(
    'environments/plugin-flutter/environment.uat.json',
    JSON.stringify({ ENV_NAME: 'uat', API_BASE_URL: 'https://uat.example.com/api' }),
  );
  tree.write('environments/plugin-flutter/htaccess.prod', '# plugin-flutter prod\n');
}

describe('env generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    seedWorkspace(tree);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('creates Angular env file for each detected app', async () => {
    await envGenerator(tree, { all: true, name: 'qa', apiUrl: 'https://qa.example.com/api' });

    expect(tree.exists('environments/web/environment.qa.ts')).toBe(true);
    expect(tree.exists('environments/mobile/environment.qa.ts')).toBe(true);
  });

  it('Angular env file is the uat file with envName and apiBaseUrl replaced', async () => {
    await envGenerator(tree, { all: true, name: 'qa', apiUrl: 'https://qa.example.com/api' });

    const content = tree.read('environments/web/environment.qa.ts')!.toString();
    expect(content).toContain("envName: 'qa'");
    expect(content).toContain("apiBaseUrl: 'https://qa.example.com/api'");
    // Default encryption settings list no keys: the value is copied.
    expect(content).toContain("password: 'uat-pass'");
  });

  it('copies secret values as is for apps without a release target (nothing fills placeholders)', async () => {
    tree.write(
      'nx.json',
      JSON.stringify({
        pstack: { envEncryption: { mode: 'listed', keys: { default: ['password'] } } },
      }),
    );
    await envGenerator(tree, { projects: ['web'], name: 'qa' });
    const content = tree.read('environments/web/environment.qa.ts')!.toString();
    expect(content).toContain("password: 'uat-pass'");
  });

  it('Angular env file sets production: false by default', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const content = tree.read('environments/web/environment.qa.ts')!.toString();
    expect(content).toContain('production: false');
  });

  it('Angular env file sets production: true when --production flag is set', async () => {
    await envGenerator(tree, { all: true, name: 'qa', production: true });

    const content = tree.read('environments/web/environment.qa.ts')!.toString();
    expect(content).toContain('production: true');
  });

  it('adds qa configuration to Angular build target with correct fileReplacements', async () => {
    await envGenerator(tree, { all: true, name: 'qa', apiUrl: 'https://qa.example.com/api' });

    const pj = readJson(tree, 'apps/web/project.json');
    expect(pj.targets.build.configurations).toHaveProperty('qa');
    expect(pj.targets.build.configurations.qa.fileReplacements[0]).toEqual({
      replace: 'environments/web/environment.ts',
      with: 'environments/web/environment.qa.ts',
    });
    expect(pj.targets.build.configurations.qa.optimization).toBe(true);
    expect(pj.targets.build.configurations.qa.sourceMap).toBe(false);
  });

  it('adds qa configuration to Angular serve target', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const pj = readJson(tree, 'apps/web/project.json');
    expect(pj.targets.serve.configurations).toHaveProperty('qa');
    expect(pj.targets.serve.configurations.qa.browserTarget).toBe('web:build:qa');
  });

  it('preserves existing configurations in project.json', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const pj = readJson(tree, 'apps/web/project.json');
    expect(pj.targets.build.configurations).toHaveProperty('production');
    expect(pj.targets.build.configurations).toHaveProperty('uat');
    expect(pj.targets.build.configurations).toHaveProperty('development');
  });

  it('creates Flutter env JSON file', async () => {
    await envGenerator(tree, { all: true, name: 'qa', apiUrl: 'https://qa.example.com/api' });

    expect(tree.exists('apps/flutter-app/env/qa.json')).toBe(true);
    const json = readJson(tree, 'apps/flutter-app/env/qa.json');
    expect(json.ENV_NAME).toBe('qa');
    expect(json.API_BASE_URL).toBe('https://qa.example.com/api');
  });

  it('keeps the copied api url when --api-url is not given', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const content = tree.read('environments/web/environment.qa.ts')!.toString();
    expect(content).toContain("apiBaseUrl: 'https://uat.example.com/api'");
    const flutterJson = readJson(tree, 'apps/flutter-app/env/qa.json');
    expect(flutterJson).toEqual({ ENV_NAME: 'qa', API_BASE_URL: 'https://uat.example.com/api' });
  });

  it('adds npm scripts for Angular apps', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const pkg = readJson(tree, 'package.json');
    expect(pkg.scripts).toHaveProperty('serve:web:qa');
    expect(pkg.scripts['serve:web:qa']).toContain('--configuration=qa');
    expect(pkg.scripts).toHaveProperty('build:web:qa');
    expect(pkg.scripts['build:web:qa']).toContain('--env=qa');
    expect(pkg.scripts).toHaveProperty('serve:mobile:qa');
    expect(pkg.scripts).toHaveProperty('build:mobile:qa');
  });

  it('adds npm scripts for run-commands Flutter app (uses --args)', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const pkg = readJson(tree, 'package.json');
    expect(pkg.scripts).toHaveProperty('build:flutter-app:qa:web');
    expect(pkg.scripts).toHaveProperty('build:flutter-app:qa:apk');
    expect(pkg.scripts).toHaveProperty('build:flutter-app:qa:ios');
    expect(pkg.scripts['build:flutter-app:qa:web']).toContain('--args=');
    expect(pkg.scripts['build:flutter-app:qa:web']).toContain('--env=qa');
  });

  it('adds npm scripts for plugin Flutter app (uses nx run with configuration)', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const pkg = readJson(tree, 'package.json');
    expect(pkg.scripts).toHaveProperty('build:plugin-flutter:qa:web');
    expect(pkg.scripts['build:plugin-flutter:qa:web']).toBe('nx run plugin-flutter:build-web:qa');
    expect(pkg.scripts['build:plugin-flutter:qa:apk']).toBe(
      'nx run plugin-flutter:build-android:qa',
    );
    expect(pkg.scripts['build:plugin-flutter:qa:ios']).toBe('nx run plugin-flutter:build-ios:qa');
  });

  it('patches project.json configurations for plugin Flutter app', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const pj = readJson(tree, 'apps/plugin-flutter/project.json');
    expect(pj.targets['build-web'].configurations).toHaveProperty('qa');
    expect(pj.targets['build-web'].configurations.qa).toEqual({ env: 'qa' });
    expect(pj.targets['build-android'].configurations).toHaveProperty('qa');
    expect(pj.targets['build-ios'].configurations).toHaveProperty('qa');
  });

  it('preserves existing configurations in plugin Flutter project.json', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const pj = readJson(tree, 'apps/plugin-flutter/project.json');
    expect(pj.targets['build-web'].configurations).toHaveProperty('dev');
    expect(pj.targets['build-web'].configurations).toHaveProperty('uat');
    expect(pj.targets['build-web'].configurations).toHaveProperty('prod');
  });

  it('does NOT patch project.json for run-commands Flutter app', async () => {
    await envGenerator(tree, { all: true, name: 'qa' });

    const pj = readJson(tree, 'apps/flutter-app/project.json');
    // run-commands Flutter apps pass env at runtime — no configurations block
    expect(pj.targets['build-web'].configurations).toBeUndefined();
  });

  // ── Validation guards ───────────────────────────────────────────────────────

  it('throws for reserved name: dev', async () => {
    await expect(envGenerator(tree, { all: true, name: 'dev' })).rejects.toThrow(
      /reserved environment name/,
    );
  });

  it('throws for reserved name: uat', async () => {
    await expect(envGenerator(tree, { all: true, name: 'uat' })).rejects.toThrow(
      /reserved environment name/,
    );
  });

  it('throws for reserved name: prod', async () => {
    await expect(envGenerator(tree, { all: true, name: 'prod' })).rejects.toThrow(
      /reserved environment name/,
    );
  });

  it('throws for reserved name: production', async () => {
    await expect(envGenerator(tree, { all: true, name: 'production' })).rejects.toThrow(
      /reserved environment name/,
    );
  });

  it('throws when name contains uppercase letters', async () => {
    await expect(envGenerator(tree, { all: true, name: 'QA' })).rejects.toThrow(
      /lowercase kebab-case/,
    );
  });

  it('throws when name contains spaces', async () => {
    await expect(envGenerator(tree, { all: true, name: 'my env' })).rejects.toThrow(
      /lowercase kebab-case/,
    );
  });

  // ── Idempotency guard ───────────────────────────────────────────────────────

  it('throws when env file already exists — does not write any files', async () => {
    tree.write('environments/web/environment.qa.ts', '// already exists\n');

    await expect(envGenerator(tree, { all: true, name: 'qa' })).rejects.toThrow(/already exists/);

    // Mobile env file must NOT have been written (fail-fast, no partial state)
    expect(tree.exists('environments/mobile/environment.qa.ts')).toBe(false);
  });

  it('throws when Flutter env file already exists', async () => {
    tree.write('apps/flutter-app/env/qa.json', '{}');

    await expect(envGenerator(tree, { all: true, name: 'qa' })).rejects.toThrow(/already exists/);
  });

  // ── No-apps guard ───────────────────────────────────────────────────────────

  it('throws when no apps are detected', async () => {
    const emptyTree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    emptyTree.write('package.json', JSON.stringify({ scripts: {} }));
    // An app with no fileReplacements and no flutter-build commands does not qualify
    emptyTree.write(
      'apps/unknown/project.json',
      JSON.stringify({ name: 'unknown', targets: { build: { executor: 'other' } } }),
    );

    await expect(envGenerator(emptyTree, { all: true, name: 'qa' })).rejects.toThrow(
      /no apps detected/,
    );
  });
});

describe('env generator on an app from pstack app --type=angular', () => {
  let t: Tree;
  beforeEach(async () => {
    t = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    t.write(
      'package.json',
      JSON.stringify({ scripts: {}, dependencies: { '@angular/core': '~15.2.0' } }),
    );
    t.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    await appGenerator(t, { name: 'portal', type: 'angular' });
  });

  it('detects the generated app and adds qa to build, serve and release', async () => {
    await envGenerator(t, { all: true, name: 'qa' });
    const pj = readJson(t, 'apps/portal/project.json');
    expect(pj.targets.build.configurations.qa.fileReplacements).toEqual([
      {
        replace: 'environments/portal/environment.ts',
        with: 'environments/portal/environment.qa.ts',
      },
    ]);
    expect(pj.targets.serve.configurations.qa).toEqual({ browserTarget: 'portal:build:qa' });
    expect(pj.targets.release.configurations.qa).toEqual({
      ...pj.targets.release.configurations.uat,
      env: 'QA',
      buildConfiguration: 'qa',
    });
    expect(pj.targets.release.configurations.qa.leakCheck).toBe('fail');
    expect(t.exists('environments/portal/environment.qa.ts')).toBe(true);
  });

  it('uses the release target in the build npm script', async () => {
    await envGenerator(t, { all: true, name: 'qa' });
    const pkg = readJson(t, 'package.json');
    expect(pkg.scripts['build:portal:qa']).toBe('nx run portal:release:qa');
    expect(pkg.scripts['serve:portal:qa']).toBe('nx serve portal --configuration=qa');
  });

  it('keeps extra production file replacements and swaps only the environment file', async () => {
    const pj = readJson(t, 'apps/portal/project.json');
    pj.targets.build.configurations.uat.fileReplacements.push({
      replace: 'apps/portal/src/config.ts',
      with: 'apps/portal/src/config.prod.ts',
    });
    t.write('apps/portal/project.json', JSON.stringify(pj));
    await envGenerator(t, { all: true, name: 'qa' });
    const qa = readJson(t, 'apps/portal/project.json').targets.build.configurations.qa;
    expect(qa.fileReplacements).toEqual([
      {
        replace: 'environments/portal/environment.ts',
        with: 'environments/portal/environment.qa.ts',
      },
      { replace: 'apps/portal/src/config.ts', with: 'apps/portal/src/config.prod.ts' },
    ]);
  });

  it("copies the app's own uat settings (budgets) into the new configuration", async () => {
    await envGenerator(t, { all: true, name: 'qa' });
    const pj = readJson(t, 'apps/portal/project.json');
    expect(pj.targets.build.configurations.qa.budgets).toEqual(
      pj.targets.build.configurations.uat.budgets,
    );
    expect(pj.targets.build.configurations.qa.outputHashing).toBe('all');
  });
});

describe('env generator on an Ionic app', () => {
  it('adds release and native build scripts for apps with cap-sync', async () => {
    const t = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    t.write(
      'package.json',
      JSON.stringify({ scripts: {}, dependencies: { '@angular/core': '~15.2.0' } }),
    );
    t.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    await appGenerator(t, { name: 'field', type: 'ionic' });
    await envGenerator(t, { all: true, name: 'qa' });
    const { scripts } = readJson(t, 'package.json');
    expect(scripts['build:field:qa']).toBe('nx run field:release:qa');
    expect(scripts['build:field:qa:android']).toBe(
      'nx run field:release:qa && nx run field:cap-sync --platform=android',
    );
    expect(scripts['build:field:qa:ios']).toBe(
      'nx run field:release:qa && nx run field:cap-sync --platform=ios',
    );
    expect(readJson(t, 'apps/field/project.json').targets.release.configurations.qa).toMatchObject({
      env: 'QA',
      buildConfiguration: 'qa',
      leakCheck: 'fail',
    });
  });
});

describe('env generator: scope, source and options', () => {
  let t: Tree;
  beforeEach(async () => {
    t = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    t.write(
      'package.json',
      JSON.stringify({ scripts: {}, dependencies: { '@angular/core': '~15.2.0' } }),
    );
    t.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    await appGenerator(t, { name: 'portal', type: 'angular', baseHref: '/portal/' });
    await appGenerator(t, { name: 'admin', type: 'angular' });
    await appGenerator(t, { name: 'mobile', type: 'flutter', baseHref: '/m/' });
  });
  const pj = (app: string) => readJson(t, `apps/${app}/project.json`);

  it('needs --app or --all and changes nothing without them', async () => {
    await expect(envGenerator(t, { name: 'qa' })).rejects.toThrow(
      'name the apps (--app=<a,b>) or pass --all',
    );
    expect(t.exists('environments/portal/environment.qa.ts')).toBe(false);
  });

  it('adds the environment to the named apps only', async () => {
    await envGenerator(t, { name: 'qa', projects: ['portal', 'mobile'] });
    expect(t.exists('environments/portal/environment.qa.ts')).toBe(true);
    expect(t.exists('environments/mobile/environment.qa.json')).toBe(true);
    expect(t.exists('environments/admin/environment.qa.ts')).toBe(false);
    expect(pj('admin').targets.release.configurations.qa).toBeUndefined();
    // Copied from uat: base href and hardening come along.
    expect(pj('portal').targets.release.configurations.qa).toMatchObject({
      env: 'QA',
      buildConfiguration: 'qa',
      baseHref: '/portal/',
      sourceMaps: 'fail',
    });
    expect(pj('mobile').targets['build-web'].configurations.qa).toEqual({
      env: 'qa',
      baseHref: '/m/',
    });
  });

  it('fails on unknown apps, listing the ones with environments', async () => {
    await expect(envGenerator(t, { name: 'qa', projects: ['ghost'] })).rejects.toThrow(
      'no app with environments named ghost (apps with environments: admin, mobile, portal)',
    );
  });

  it('copies --from=prod and sets --production, --base-href and --domains', async () => {
    const release = pj('portal');
    release.targets.release.configurations.prod.domains = ['portal.example.com'];
    t.write('apps/portal/project.json', JSON.stringify(release));
    await envGenerator(t, {
      name: 'sit',
      projects: ['portal'],
      from: 'prod',
      production: false,
      baseHref: '/sit/',
      domains: ['sit.example.com'],
    });
    const conf = pj('portal').targets;
    expect(conf.release.configurations.sit).toMatchObject({
      env: 'SIT',
      buildConfiguration: 'sit',
      baseHref: '/sit/',
      domains: ['sit.example.com'],
    });
    expect(conf.build.configurations.sit.fileReplacements[0].with).toBe(
      'environments/portal/environment.sit.ts',
    );
    const file = t.read('environments/portal/environment.sit.ts', 'utf-8') as string;
    expect(file).toContain("envName: 'sit'");
    expect(file).toContain('production: false');
  });

  it('does not copy the domain lock of the source environment', async () => {
    const json = pj('portal');
    json.targets.release.configurations.uat.domains = ['uat.example.com'];
    t.write('apps/portal/project.json', JSON.stringify(json));
    await envGenerator(t, { name: 'qa', projects: ['portal'] });
    expect(pj('portal').targets.release.configurations.qa.domains).toBeUndefined();
  });

  it('lists every problem and writes nothing', async () => {
    t.write('environments/portal/environment.qa.ts', '// here\n');
    const err = await envGenerator(t, {
      name: 'qa',
      projects: ['portal', 'admin'],
      from: 'staging',
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain(
      '- portal: environments/portal/environment.qa.ts already exists',
    );
    expect((err as Error).message).toContain('- portal: no "staging" configuration to copy');
    expect((err as Error).message).toContain('- admin: no "staging" configuration to copy');
    expect(t.exists('environments/admin/environment.qa.ts')).toBe(false);
  });

  it('rejects a bad base href or domain before writing', async () => {
    await expect(
      envGenerator(t, { name: 'qa', projects: ['portal'], baseHref: 'qa' }),
    ).rejects.toThrow('must start and end with "/"');
    await expect(
      envGenerator(t, { name: 'qa', projects: ['portal'], domains: ['bad host'] }),
    ).rejects.toThrow('--domains');
    expect(t.exists('environments/portal/environment.qa.ts')).toBe(false);
  });

  it('new apps get dev, uat and prod only, whatever other apps have', async () => {
    await envGenerator(t, { name: 'qa', all: true });
    await appGenerator(t, { name: 'late', type: 'angular' });
    await appGenerator(t, { name: 'late-mobile', type: 'flutter' });
    expect(Object.keys(pj('late').targets.release.configurations).sort()).toEqual([
      'dev',
      'prod',
      'uat',
    ]);
    expect(Object.keys(pj('late').targets.build.configurations).sort()).toEqual([
      'development',
      'production',
      'uat',
    ]);
    expect(t.exists('environments/late/environment.qa.ts')).toBe(false);
    expect(Object.keys(pj('late-mobile').targets['build-web'].configurations).sort()).toEqual([
      'dev',
      'prod',
      'uat',
    ]);
    expect(t.exists('environments/late-mobile/environment.qa.json')).toBe(false);
  });

  it('turns secret fields into placeholders for apps with a release target', async () => {
    t.write(
      'environments/portal/environment.uat.ts',
      "export const environment = { production: false, envName: 'uat', password: 'p', appName: 'Portal' };\n",
    );
    const nx = readJson(t, 'nx.json');
    nx.pstack = { envEncryption: { mode: 'all' } };
    t.write('nx.json', JSON.stringify(nx));
    await envGenerator(t, { name: 'qa', projects: ['portal'] });
    const file = t.read('environments/portal/environment.qa.ts', 'utf-8') as string;
    expect(file).toContain("password: '${PORTAL_QA_PASSWORD}'");
    // Not sensitive-looking: copied.
    expect(file).toContain("appName: 'Portal'");
  });

  it('writes the file where the release build reads it (shared replace path, nx15 layout)', async () => {
    for (const app of ['portal', 'admin']) {
      const json = pj(app);
      for (const c of Object.values(json.targets.build.configurations) as Array<{
        fileReplacements?: Array<{ replace: string; with: string }>;
      }>) {
        for (const r of c.fileReplacements ?? []) r.replace = 'environments/environment.ts';
      }
      t.write(`apps/${app}/project.json`, JSON.stringify(json));
    }
    t.write('environments/environment.ts', "export const environment = { envName: 'dev' };\n");
    await envGenerator(t, { name: 'qa', projects: ['portal', 'admin'] });
    expect(t.exists('environments/portal/environment.qa.ts')).toBe(true);
    expect(t.exists('environments/admin/environment.qa.ts')).toBe(true);
    expect(t.exists('environments/environment.qa.ts')).toBe(false);
    expect(pj('admin').targets.build.configurations.qa.fileReplacements[0]).toEqual({
      replace: 'environments/environment.ts',
      with: 'environments/admin/environment.qa.ts',
    });
  });

  it('flutter: an explicit --from must exist, and an existing configuration is a problem', async () => {
    await expect(
      envGenerator(t, { name: 'qa', projects: ['mobile'], from: 'staging' }),
    ).rejects.toThrow(/mobile: environments\/mobile\/environment\.staging\.json not found/);
    const json = pj('mobile');
    json.targets['build-ios'].configurations.qa = { env: 'qa' };
    t.write('apps/mobile/project.json', JSON.stringify(json));
    await expect(envGenerator(t, { name: 'qa', projects: ['mobile'] })).rejects.toThrow(
      'mobile: build-ios configuration "qa" already exists',
    );
  });

  it('copies htaccess.prod to htaccess.<env> for web release builds', async () => {
    t.write('environments/portal/htaccess.prod', '# portal prod rules\n');
    t.write('environments/mobile/htaccess.prod', '# mobile prod rules\n');
    await envGenerator(t, { name: 'ppd', projects: ['portal', 'mobile'] });
    expect(t.read('environments/portal/htaccess.ppd', 'utf-8')).toBe('# portal prod rules\n');
    expect(t.read('environments/mobile/htaccess.ppd', 'utf-8')).toBe('# mobile prod rules\n');
  });

  it('copies the prod-only CSP sources (envs.prod) to the new env, keeping an existing one', async () => {
    t.write(
      'apps/portal/csp-allowlist.json',
      JSON.stringify({
        'connect-src': ['https://api.example.com'],
        envs: { prod: { 'img-src': ['https://cdn.example.com'] } },
      }),
    );
    t.write('apps/admin/csp-allowlist.json', JSON.stringify({ envs: { ppd: {}, uat: {} } }));
    await envGenerator(t, { name: 'ppd', projects: ['portal', 'admin'] });
    expect(readJson(t, 'apps/portal/csp-allowlist.json').envs).toEqual({
      ppd: { 'img-src': ['https://cdn.example.com'] },
      prod: { 'img-src': ['https://cdn.example.com'] },
    });
    // No envs.prod: nothing to copy, the file is left as it was.
    expect(readJson(t, 'apps/admin/csp-allowlist.json')).toEqual({ envs: { ppd: {}, uat: {} } });
  });

  it('needs htaccess.prod to copy, and never replaces an existing htaccess.<env>', async () => {
    t.delete('environments/portal/htaccess.prod');
    t.write('environments/mobile/htaccess.qa', '# hand-written\n');
    const err = await envGenerator(t, { name: 'qa', projects: ['portal', 'mobile'] }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toContain(
      '- portal: environments/portal/htaccess.prod not found',
    );
    expect((err as Error).message).toContain(
      '- mobile: environments/mobile/htaccess.qa already exists',
    );
    expect(t.exists('environments/portal/environment.qa.ts')).toBe(false);
    expect(t.read('environments/mobile/htaccess.qa', 'utf-8')).toBe('# hand-written\n');
  });

  it('writes no htaccess.<env> for builds with htaccess: false', async () => {
    const portal = pj('portal');
    portal.targets.release.options.htaccess = false;
    t.write('apps/portal/project.json', JSON.stringify(portal));
    const mobile = pj('mobile');
    mobile.targets['build-web'].options.htaccess = false;
    t.write('apps/mobile/project.json', JSON.stringify(mobile));
    t.delete('environments/portal/htaccess.prod');
    await envGenerator(t, { name: 'qa', projects: ['portal', 'mobile'] });
    expect(t.exists('environments/portal/htaccess.qa')).toBe(false);
    expect(t.exists('environments/mobile/htaccess.qa')).toBe(false);
    expect(t.exists('environments/portal/environment.qa.ts')).toBe(true);
  });

  it('tells a Flutter app still on apps/<app>/env/ to run pstack update', async () => {
    t.rename('environments/mobile/environment.dev.json', 'apps/mobile/env/dev.json');
    t.rename('environments/mobile/environment.uat.json', 'apps/mobile/env/uat.json');
    t.rename('environments/mobile/environment.prod.json', 'apps/mobile/env/prod.json');
    for (const f of t.children('environments/mobile')) t.delete(`environments/mobile/${f}`);
    await expect(envGenerator(t, { name: 'qa', projects: ['mobile'] })).rejects.toThrow(
      'mobile: its env files are still in apps/mobile/env/; pstack update moves them to environments/mobile/',
    );
  });

  it('validates the name and the api url', async () => {
    for (const bad of ['qa-', 'a--b', '-qa']) {
      await expect(envGenerator(t, { name: bad, all: true })).rejects.toThrow(
        /lowercase kebab-case/,
      );
    }
    await expect(
      envGenerator(t, { name: 'qa', all: true, apiUrl: "https://x.com/'; alert(1)" }),
    ).rejects.toThrow('--api-url must be an http(s) URL');
  });
});
