import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import envFilesLayout, {
  migrateEnvFilesLayout,
} from '../../src/migrations/env-files-layout/env-files-layout';

const RELEASE = '@mouryaamit/nx-polystack:build';
const FLUTTER = '@mouryaamit/nx-polystack:flutter-build';

const write = (tree: Tree, file: string, json: unknown) =>
  tree.write(file, JSON.stringify(json, null, 2));
const pj = (tree: Tree, app: string) => readJson(tree, `apps/${app}/project.json`);

/** An Angular app as pstack app wrote it before 1.5.1. */
function angularApp(tree: Tree, name: string, withHtaccess = true): void {
  write(tree, `apps/${name}/project.json`, {
    name,
    targets: {
      build: {
        executor: '@angular-devkit/build-angular:browser',
        options: { assets: withHtaccess ? [`apps/${name}/src/.htaccess`] : [] },
        configurations: { production: {}, uat: {}, development: {} },
      },
      release: {
        executor: RELEASE,
        options: { buildTarget: `${name}:build`, envProject: name },
        configurations: {
          dev: { env: 'DEV', buildConfiguration: 'development' },
          uat: { env: 'UAT', buildConfiguration: 'uat' },
          prod: { env: 'PROD', buildConfiguration: 'production' },
        },
      },
    },
  });
  if (withHtaccess) tree.write(`apps/${name}/src/.htaccess`, `# ${name} rules\n`);
}

/** The sample's Flutter app: nx:run-commands on the workspace-local script. */
function scriptFlutterApp(tree: Tree, name = 'flutter-app'): void {
  const cmd = (target: string) =>
    `node tools/scripts/flutter/flutter-build.js --project=${name} --target=${target} --env={args.env}`;
  write(tree, `apps/${name}/project.json`, {
    name,
    targets: {
      'build-web': { executor: 'nx:run-commands', options: { command: cmd('web') } },
      'build-android': { executor: 'nx:run-commands', options: { command: cmd('apk') } },
      'build-ios': { executor: 'nx:run-commands', options: { command: cmd('ios') } },
      serve: { executor: 'nx:run-commands', options: { command: cmd('web-server') } },
      export: {
        executor: 'nx:run-commands',
        options: { command: `node tools/scripts/flutter/flutter-export.js --project=${name}` },
      },
    },
  });
  for (const env of ['dev', 'uat', 'prod']) {
    tree.write(`apps/${name}/env/${env}.json`, `{ "ENV": "${env}" }\n`);
  }
}

/** A Flutter app as pstack app wrote it before 1.5.1. */
function pluginFlutterApp(tree: Tree, name = 'mobile'): void {
  write(tree, `apps/${name}/project.json`, {
    name,
    targets: {
      'build-web': {
        executor: FLUTTER,
        options: { target: 'web', dist: `dist/apps/${name}/web` },
        configurations: { dev: { env: 'dev' }, uat: { env: 'uat' }, prod: { env: 'prod' } },
      },
      'build-android': {
        executor: FLUTTER,
        options: { target: 'apk' },
        configurations: { dev: { env: 'dev' }, prod: { env: 'prod' } },
      },
    },
  });
  for (const env of ['dev', 'uat', 'prod']) {
    tree.write(`apps/${name}/env/${env}.json`, `{ "ENV": "${env}" }\n`);
  }
}

describe('env-files-layout migration (v1.5.2)', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('turns an Angular app’s .htaccess asset into one htaccess.<env> per release env', () => {
    angularApp(tree, 'web');
    const r = migrateEnvFilesLayout(tree);
    for (const env of ['dev', 'uat', 'prod']) {
      expect(tree.read(`environments/web/htaccess.${env}`, 'utf-8')).toBe('# web rules\n');
    }
    expect(tree.exists('apps/web/src/.htaccess')).toBe(false);
    expect(pj(tree, 'web').targets.build.options.assets).toEqual([]);
    expect(pj(tree, 'web').targets.release.options.htaccess).toBeUndefined();
    expect(r.changes[0]).toContain('web: `apps/web/src/.htaccess` became the env files');
  });

  it('sets htaccess: false on an Angular app that built none, and keeps apps already moved', () => {
    angularApp(tree, 'plain', false);
    angularApp(tree, 'new', false);
    for (const env of ['dev', 'uat', 'prod']) tree.write(`environments/new/htaccess.${env}`, '#\n');
    migrateEnvFilesLayout(tree);
    expect(pj(tree, 'plain').targets.release.options.htaccess).toBe(false);
    expect(pj(tree, 'new').targets.release.options.htaccess).toBeUndefined();
  });

  it('converts the sample’s run-commands Flutter targets and moves its env files', () => {
    scriptFlutterApp(tree);
    const r = migrateEnvFilesLayout(tree);
    const t = pj(tree, 'flutter-app').targets;
    expect(t['build-web']).toEqual({
      executor: FLUTTER,
      options: { target: 'web', dist: 'dist/apps/flutter-app/web', htaccess: false },
      configurations: { dev: { env: 'dev' }, uat: { env: 'uat' }, prod: { env: 'prod' } },
    });
    expect(t['build-android'].executor).toBe(FLUTTER);
    expect(t['build-ios'].options).toEqual({ target: 'ios' });
    expect(t.serve).toEqual({ executor: FLUTTER, options: { target: 'web', serve: true } });
    // Not one of the converted targets: left as it was.
    expect(t.export.executor).toBe('nx:run-commands');
    expect(tree.read('environments/flutter-app/environment.uat.json', 'utf-8')).toBe(
      '{ "ENV": "uat" }\n',
    );
    expect(tree.exists('apps/flutter-app/env/uat.json')).toBe(false);
    expect(r.changes.join('\n')).toContain(
      "flutter-app: build-web, build-android, build-ios, serve now use the plugin's flutter-build executor",
    );
  });

  it('leaves run-commands targets that are not exactly the earlier script command', () => {
    scriptFlutterApp(tree);
    const json = pj(tree, 'flutter-app');
    json.targets['build-web'].options.command += ' --obfuscate';
    write(tree, 'apps/flutter-app/project.json', json);
    migrateEnvFilesLayout(tree);
    const t = pj(tree, 'flutter-app').targets;
    expect(t['build-web'].executor).toBe('nx:run-commands');
    expect(t['build-android'].executor).toBe(FLUTTER);
  });

  it('moves a plugin Flutter app’s env files, never replacing one, and turns htaccess off', () => {
    pluginFlutterApp(tree);
    tree.write('environments/mobile/environment.prod.json', '{ "mine": true }\n');
    const r = migrateEnvFilesLayout(tree);
    expect(tree.read('environments/mobile/environment.dev.json', 'utf-8')).toBe(
      '{ "ENV": "dev" }\n',
    );
    expect(tree.read('environments/mobile/environment.prod.json', 'utf-8')).toBe(
      '{ "mine": true }\n',
    );
    expect(tree.exists('apps/mobile/env/prod.json')).toBe(true);
    expect(tree.exists('apps/mobile/env/dev.json')).toBe(false);
    expect(pj(tree, 'mobile').targets['build-web'].options.htaccess).toBe(false);
    expect(r.changes.join('\n')).toContain('mobile: kept apps/mobile/env/prod.json');
  });

  it('keeps htaccess on for a Flutter app that already has htaccess.<env> files', () => {
    pluginFlutterApp(tree);
    tree.write('environments/mobile/htaccess.prod', '# prod\n');
    migrateEnvFilesLayout(tree);
    expect(pj(tree, 'mobile').targets['build-web'].options.htaccess).toBeUndefined();
  });

  it('lists scripts, workflows and Jenkinsfiles that still name old paths, without changing them', async () => {
    scriptFlutterApp(tree);
    angularApp(tree, 'web');
    const pkg = readJson(tree, 'package.json');
    pkg.scripts = {
      'build:flutter-app:uat:web':
        'cross-env NODE_ENV=production nx run flutter-app:build-web --args="--env=uat"',
      'check:env': 'cat apps/flutter-app/env/uat.json',
      'build:web': 'nx run web:release:uat',
      'build:flutter-app:uat:apk:hardened':
        'cross-env NODE_ENV=production node tools/scripts/flutter/flutter-build.js --project=flutter-app --target=apk --env=uat  --obfuscate',
      'build:other:apk':
        'node tools/scripts/flutter/flutter-build.js --project=flutter-app-two --target=apk --env=uat',
    };
    write(tree, 'package.json', pkg);
    tree.write('.github/workflows/ci.yml', 'steps:\n  - run: cp apps/web/src/.htaccess dist/\n');
    tree.write('Jenkinsfile', "sh 'ls apps/flutter-app/env/'\n");
    const before = tree.read('package.json', 'utf-8');
    const r = migrateEnvFilesLayout(tree);
    const refs = r.references.join('\n');
    expect(refs).toContain('package.json:6:');
    expect(refs).toContain('nx run flutter-app:build-web --args=\\"--env=uat\\"');
    expect(refs).toContain('cat apps/flutter-app/env/uat.json');
    expect(refs).toMatch(/\.github\/workflows\/ci\.yml:2: - run: cp apps\/web\/src\/\.htaccess/);
    expect(refs).toContain("Jenkinsfile:1: sh 'ls apps/flutter-app/env/'");
    expect(refs).not.toContain('nx run web:release:uat');
    // Direct calls of the old script read apps/flutter-app/env/, which moved.
    expect(refs).toContain('flutter-build.js --project=flutter-app --target=apk --env=uat');
    expect(refs).not.toContain('flutter-app-two');
    expect(tree.read('package.json', 'utf-8')).toBe(before);
    await expect(envFilesLayout(tree)).resolves.toBeUndefined();
  });

  it('keeps project.json files in the workspace Prettier style (short arrays on one line)', async () => {
    scriptFlutterApp(tree);
    const json = pj(tree, 'flutter-app');
    json.tags = ['scope:app', 'type:app', 'platform:flutter'];
    write(tree, 'apps/flutter-app/project.json', json);
    await envFilesLayout(tree);
    const text = tree.read('apps/flutter-app/project.json', 'utf-8') as string;
    expect(text).toContain('"tags": ["scope:app", "type:app", "platform:flutter"]');
  });

  it('leaves the root tsconfig paths in their order', async () => {
    scriptFlutterApp(tree);
    const tsconfig = readJson(tree, 'tsconfig.base.json');
    tsconfig.compilerOptions.paths = { '@b/x': ['libs/b'], '@a/x': ['libs/a'] };
    write(tree, 'tsconfig.base.json', tsconfig);
    const before = tree.read('tsconfig.base.json', 'utf-8');
    await envFilesLayout(tree);
    expect(tree.read('tsconfig.base.json', 'utf-8')).toBe(before);
  });

  it('changes nothing on a second run', () => {
    angularApp(tree, 'web');
    scriptFlutterApp(tree);
    migrateEnvFilesLayout(tree);
    const snapshot = tree.listChanges().map((c) => [c.path, c.content?.toString()]);
    const again = migrateEnvFilesLayout(tree);
    expect(again.changes).toEqual([]);
    expect(tree.listChanges().map((c) => [c.path, c.content?.toString()])).toEqual(snapshot);
  });
});
