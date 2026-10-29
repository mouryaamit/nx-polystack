import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { runAdopt } from '../../src/cli/commands/adopt';
import { runEnv } from '../../src/cli/commands/env';
import { buildsWeb } from '../../src/generators/adopt/flutter';
import { detectSourceEnvEncryption } from '../../src/generators/migrate/nx/env-encryption';

import { makeCtx, tmpDir, writeJson } from './helpers';

/**
 * An Nx 22 workspace (Angular application builder + a Flutter app) whose one build script builds
 * both apps from a per-app map, injects the nonce on every script, link and style, gives the root
 * element ngCspNonce, and encrypts the env fields it lists with CryptoJS.
 */
const BUILD_JS = `// tools/scripts/build.js
const { encryptEnvFile } = require('./encrypt-env');
const { getBuildInfo } = require('./build-info');
const APPS = {
  web: { type: 'angular', dist: 'dist/site', baseHref: '/' },
  resources: { type: 'flutter', dist: 'dist/resources_out', baseHref: '/resources/' },
};
function buildFlutter(baseHref) {
  run(['flutter build web --release', \`--base-href \${baseHref}\`, \`--output \${path.resolve(app.dist)}\`].join(' '));
}
run(\`node tools/scripts/inject-nonce.js \${app.dist}\`);
run(\`node tools/scripts/inject-meta.js \${app.dist}/index.html \${env}\`);
if (env === 'prod') run(\`node tools/scripts/strip-exif.js \${app.dist}\`);
`;

const INJECT_NONCE_JS = `const NONCE = "<!--#echo var='UNIQUE_ID' -->";
const TOKENS = /<!--(?!#)[\\s\\S]*?-->|(<(script|style)\\b[^>]*>)([\\s\\S]*?)(<\\/\\2\\s*>)/gi;
function processMarkup(markup) {
  markup = markup.replace(/<script(?![^>]*\\bnonce=)([^>]*)>/gi, \`<script nonce="\${NONCE}"$1>\`);
  markup = markup.replace(/<link(?![^>]*\\bnonce=)([^>]*)>/gi, \`<link nonce="\${NONCE}"$1>\`);
  markup = markup.replace(/<style(?![^>]*\\bnonce=)([^>]*)>/gi, \`<style nonce="\${NONCE}"$1>\`);
  markup = markup.replace(/<app-root(?![^>]*ngCspNonce)/i, \`<app-root ngCspNonce="\${NONCE}"\`);
  return markup;
}
html = html.replace(/random-csp-nonce/g, NONCE);
html = html.replace(/<\\/head>/i, \`  <meta property="csp-nonce" content="\${NONCE}">\\n</head>\`);
`;

const ENCRYPT_ENV_JS = `const CryptoJS = require('crypto-js');
const ENCRYPTED_ENV_KEYS = ['password', 'uname', 'key', 'iv'];
function encryptEnvFile(file, commit) {
  for (const key of ENCRYPTED_ENV_KEYS) {
    src = src.replace(re, (m, prefix, _q, value) => \`\${prefix}'\${CryptoJS.AES.encrypt(value, commit).toString()}'\`);
  }
}
module.exports = { encryptEnvFile, ENCRYPTED_ENV_KEYS };
`;

function workspace(opts: { envJson?: boolean } = {}): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), { targetDefaults: {} });
  const scripts: Record<string, string> = {
    'serve:web': 'nx run web:serve',
    'serve:resources': 'nx run resources:serve',
    'assets:strip-exif': 'node tools/scripts/strip-exif.js apps/web/src/assets',
  };
  for (const a of ['web', 'resources']) {
    scripts[`build:${a}:development`] = `node tools/scripts/build.js --project=${a} --env=dev`;
    scripts[`build:${a}:production`] = `node tools/scripts/build.js --project=${a} --env=prod`;
  }
  writeJson(path.join(ws, 'package.json'), { name: 'site', scripts });
  const tools = path.join(ws, 'tools', 'scripts');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, 'build.js'), BUILD_JS);
  fs.writeFileSync(path.join(tools, 'inject-nonce.js'), INJECT_NONCE_JS);
  fs.writeFileSync(path.join(tools, 'encrypt-env.js'), ENCRYPT_ENV_JS);
  fs.writeFileSync(path.join(tools, 'inject-meta.js'), "require('./build-info');\n");
  fs.writeFileSync(path.join(tools, 'strip-exif.js'), '// strip\n');
  fs.writeFileSync(path.join(tools, 'patch-assets.js'), '// FlutterFlow export helper\n');
  fs.writeFileSync(
    path.join(tools, 'build-info.js'),
    "const f = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata' });\n",
  );

  // Angular 21 application builder, outputPath { base, browser: '' }.
  writeJson(path.join(ws, 'apps/web/project.json'), {
    name: 'web',
    projectType: 'application',
    sourceRoot: 'apps/web/src',
    targets: {
      build: {
        executor: '@angular/build:application',
        options: {
          outputPath: { base: 'dist/site', browser: '' },
          browser: 'apps/web/src/main.ts',
          assets: ['apps/web/src/favicon.ico', 'apps/web/src/.htaccess'],
        },
        configurations: {
          production: {
            fileReplacements: [
              {
                replace: 'environments/web/environment.ts',
                with: 'environments/web/environment.production.ts',
              },
            ],
          },
          development: {
            fileReplacements: [
              {
                replace: 'environments/web/environment.ts',
                with: 'environments/web/environment.development.ts',
              },
            ],
          },
        },
        defaultConfiguration: 'production',
      },
      serve: { executor: '@angular/build:dev-server' },
    },
  });
  fs.mkdirSync(path.join(ws, 'apps/web/src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'apps/web/src/.htaccess'), '# web rules\n');
  fs.mkdirSync(path.join(ws, 'environments/web'), { recursive: true });
  for (const f of ['environment.ts', 'environment.development.ts', 'environment.production.ts']) {
    fs.writeFileSync(
      path.join(ws, 'environments/web', f),
      "export const environment = { production: false, timeStamp: '', branchName: '' };\n",
    );
  }

  // Flutter app built by run-commands through the script.
  writeJson(path.join(ws, 'apps/resources/project.json'), {
    name: 'resources',
    projectType: 'application',
    sourceRoot: 'apps/resources/lib',
    targets: {
      serve: {
        executor: 'nx:run-commands',
        options: { command: 'flutter run -d chrome --web-port=4200', cwd: 'apps/resources' },
      },
      'build-web': {
        executor: 'nx:run-commands',
        options: { cwd: '.', parallel: false },
        configurations: {
          development: { command: 'node tools/scripts/build.js --project=resources --env=dev' },
          production: { command: 'node tools/scripts/build.js --project=resources --env=prod' },
        },
      },
      'build-android': {
        executor: 'nx:run-commands',
        options: { command: 'flutter build apk --release', cwd: 'apps/resources' },
      },
    },
  });
  fs.writeFileSync(path.join(ws, 'apps/resources/pubspec.yaml'), 'name: resources\n');
  fs.mkdirSync(path.join(ws, 'apps/resources/web'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'apps/resources/web/.htaccess'), '# resources rules\n');
  if (opts.envJson) {
    fs.mkdirSync(path.join(ws, 'apps/resources/env'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'apps/resources/env/prod.json'), '{ "API": "p" }\n');
  }
  return ws;
}

const readJson = (ws: string, rel: string) =>
  JSON.parse(fs.readFileSync(path.join(ws, rel), 'utf8'));
const read = (ws: string, rel: string) => fs.readFileSync(path.join(ws, rel), 'utf8');
const exists = (ws: string, rel: string) => fs.existsSync(path.join(ws, rel));

describe('pstack adopt: Angular application builder and Flutter apps (NX-108)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('gives the Angular app a release target that does what the script did', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    const release = readJson(ws, 'apps/web/project.json').targets.release;
    expect(release.options).toMatchObject({
      outputPath: 'dist/site',
      envProject: 'web',
      secure: true,
      stripHtmlComments: true,
      nonce: {
        placeholder: "<!--#echo var='UNIQUE_ID' -->",
        tags: 'every',
        position: 'after-tag-name',
        replaceTokens: ['random-csp-nonce'],
        ngCspNonce: 'app-root',
      },
    });
    expect(release.options.nonce.addMeta).toBeUndefined();
    expect(Object.keys(release.configurations).sort()).toEqual(['dev', 'prod']);
    expect(release.configurations.prod.baseHref).toBeUndefined();
    for (const env of ['dev', 'prod']) {
      expect(read(ws, `environments/web/htaccess.${env}`)).toBe('# web rules\n');
    }

    // Listed-mode env encryption: the fields the script names, raw CryptoJS, commit key.
    const enc = readJson(ws, 'nx.json').pstack.envEncryption;
    expect(enc).toMatchObject({
      mode: 'listed',
      format: 'raw',
      cipher: 'cryptojs',
      keySources: ['commit'],
      keys: { default: ['password', 'uname', 'key', 'iv'] },
    });
    expect(enc.stamp).toMatchObject({
      timeField: 'timeStamp',
      branchField: 'branchName',
      timezone: 'Asia/Kolkata',
    });
  });

  it('moves the Flutter web build to flutter-build with the env files and .htaccess', async () => {
    const ws = workspace({ envJson: true });
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    const pj = readJson(ws, 'apps/resources/project.json');
    const web = pj.targets['build-web'];
    expect(web).toEqual({
      executor: '@mouryaamit/nx-polystack:flutter-build',
      options: {
        target: 'web',
        dist: 'dist/resources_out',
        secure: true,
        nonce: {
          placeholder: "<!--#echo var='UNIQUE_ID' -->",
          tags: 'every',
          position: 'after-tag-name',
          replaceTokens: ['random-csp-nonce'],
        },
        stripHtmlComments: true,
      },
      configurations: {
        dev: { env: 'dev', baseHref: '/resources/' },
        prod: { env: 'prod', baseHref: '/resources/' },
      },
      defaultConfiguration: 'dev',
    });
    // Other targets as they were, in the same order.
    expect(Object.keys(pj.targets)).toEqual(['serve', 'build-web', 'build-android']);
    expect(pj.targets['build-android'].executor).toBe('nx:run-commands');

    expect(readJson(ws, 'environments/resources/environment.prod.json')).toEqual({ API: 'p' });
    expect(exists(ws, 'apps/resources/env/prod.json')).toBe(false);
    expect(read(ws, 'environments/resources/environment.dev.json')).toBe('{}\n');
    for (const env of ['dev', 'prod']) {
      expect(read(ws, `environments/resources/htaccess.${env}`)).toBe('# resources rules\n');
    }
    expect(exists(ws, 'apps/resources/web/.htaccess')).toBe(false);

    const report = read(ws, 'docs/migrations/adopt.md');
    expect(report).toContain('Apps moved to the polystack `release` target: `web`.');
    expect(report).toContain('`flutter-build` executor: `resources`.');
    expect(report).toContain('left as they were: `serve`, `build-android`');
  });

  it('writes flutter-build options its schema accepts', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../src/executors/flutter-build/schema.json'),
        'utf8',
      ),
    ).properties as Record<string, { type?: string; properties?: Record<string, unknown> }>;
    const web = readJson(ws, 'apps/resources/project.json').targets['build-web'];
    for (const opts of [web.options, ...Object.values(web.configurations)] as Record<
      string,
      unknown
    >[]) {
      for (const key of Object.keys(opts))
        expect({ key, known: !!schema[key] }).toEqual({ key, known: true });
    }
    for (const key of Object.keys(web.options.nonce)) {
      expect(schema['nonce'].properties?.[key]).toBeDefined();
    }
  });

  it('points the npm scripts at the new targets under their own names', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    const scripts = readJson(ws, 'package.json').scripts;
    expect(scripts['build:web:development']).toBe('nx run web:release:dev');
    expect(scripts['build:web:production']).toBe('nx run web:release:prod');
    expect(scripts['build:web:prod:secure']).toBe('nx run web:release:prod --secure');
    expect(scripts['build:web:dev']).toBeUndefined();
    expect(scripts['build:resources:development']).toBe('nx run resources:build-web:dev');
    expect(scripts['build:resources:production']).toBe('nx run resources:build-web:prod');
    expect(scripts['build:resources:prod']).toBeUndefined();
  });

  it('removes the old pipeline but keeps scripts something still runs', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: { removeOldScripts: true } }));
    for (const f of ['build.js', 'inject-nonce.js', 'encrypt-env.js', 'inject-meta.js']) {
      expect({ f, exists: exists(ws, `tools/scripts/${f}`) }).toEqual({ f, exists: false });
    }
    expect(exists(ws, 'tools/scripts/strip-exif.js')).toBe(true);
    expect(exists(ws, 'tools/scripts/patch-assets.js')).toBe(true);
  });

  it('adopts only the Flutter app with --app, and leaves it alone the second time', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: { app: 'resources' } }));
    expect(readJson(ws, 'apps/web/project.json').targets.release).toBeUndefined();
    const before = read(ws, 'apps/resources/project.json');
    await expect(runAdopt(makeCtx({ cwd: ws, flags: { app: 'resources' } }))).rejects.toThrow(
      '"resources" is not an app that builds without the plugin (candidates: web)',
    );
    expect(read(ws, 'apps/resources/project.json')).toBe(before);
  });

  it('then pstack env --name=uat adds UAT to both apps, copied from prod', async () => {
    const ws = workspace({ envJson: true });
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    await runEnv(makeCtx({ cwd: ws, flags: { name: 'uat', all: true } }));

    const web = readJson(ws, 'apps/web/project.json').targets;
    expect(web.build.configurations.uat.fileReplacements).toEqual([
      { replace: 'environments/web/environment.ts', with: 'environments/web/environment.uat.ts' },
    ]);
    expect(web.release.configurations.uat).toMatchObject({ env: 'UAT', buildConfiguration: 'uat' });
    expect(exists(ws, 'environments/web/environment.uat.ts')).toBe(true);
    expect(read(ws, 'environments/web/htaccess.uat')).toBe('# web rules\n');

    const res = readJson(ws, 'apps/resources/project.json').targets['build-web'];
    expect(res.configurations.uat).toEqual({ env: 'uat', baseHref: '/resources/' });
    expect(readJson(ws, 'environments/resources/environment.uat.json')).toMatchObject({ API: 'p' });
    expect(read(ws, 'environments/resources/htaccess.uat')).toBe('# resources rules\n');

    const scripts = readJson(ws, 'package.json').scripts;
    expect(scripts['build:web:uat']).toBe('nx run web:release:uat');
    expect(scripts['build:resources:uat:web']).toBe('nx run resources:build-web:uat');
    // run-commands apk build: no env configuration, no script.
    expect(
      readJson(ws, 'apps/resources/project.json').targets['build-android'].configurations,
    ).toBeUndefined();
    expect(scripts['build:resources:uat:apk']).toBeUndefined();
  });

  it('matches the app by its exact name and only web builds of a script', () => {
    expect(buildsWeb('node tools/scripts/build.js --project=shop --env=prod', 'shop')).toBe(true);
    expect(buildsWeb('node tools/scripts/build.js --project=shop-admin --env=prod', 'shop')).toBe(
      false,
    );
    expect(buildsWeb('node tools/scripts/build.js --project=shop --target=apk', 'shop')).toBe(
      false,
    );
    expect(
      buildsWeb('node tools/scripts/flutter/flutter-build.js --project=shop --target=web', 'shop'),
    ).toBe(false);
    expect(buildsWeb('flutter build web --release', 'shop')).toBe(true);
  });

  it('leaves apps on the older generated flutter-build.js wrapper to pstack update', async () => {
    const ws = workspace();
    const file = path.join(ws, 'apps/resources/project.json');
    const pj = JSON.parse(fs.readFileSync(file, 'utf8'));
    pj.targets['build-web'] = {
      executor: 'nx:run-commands',
      options: {
        command:
          'node tools/scripts/flutter/flutter-build.js --project=resources --target=web --env={args.env}',
      },
    };
    fs.writeFileSync(file, JSON.stringify(pj, null, 2));
    const before = fs.readFileSync(file, 'utf8');
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(read(ws, 'docs/migrations/adopt.md')).not.toContain('resources');
    expect(exists(ws, 'environments/resources')).toBe(false);
  });

  it('finds env/<config name>.json, keeps a file another target still uses, and adds no nonce to a direct flutter build', async () => {
    const ws = workspace();
    const file = path.join(ws, 'apps/resources/project.json');
    const pj = JSON.parse(fs.readFileSync(file, 'utf8'));
    pj.targets['build-web'] = {
      executor: 'nx:run-commands',
      options: { cwd: 'apps/resources' },
      configurations: {
        production: {
          command:
            'flutter build web --release --dart-define-from-file=env/production.json --base-href /r/ --output ../../dist/r',
        },
      },
    };
    pj.targets['build-android'].options.command =
      'flutter build apk --release --dart-define-from-file=env/production.json';
    fs.writeFileSync(file, JSON.stringify(pj, null, 2));
    fs.mkdirSync(path.join(ws, 'apps/resources/env'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'apps/resources/env/production.json'), '{ "A": 1 }\n');
    // Only the web build: the npm scripts no longer build the app through the script.
    const pkg = readJson(ws, 'package.json');
    delete pkg.scripts['build:resources:development'];
    delete pkg.scripts['build:resources:production'];
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify(pkg, null, 2));

    await runAdopt(makeCtx({ cwd: ws, flags: { app: 'resources' } }));
    const web = readJson(ws, 'apps/resources/project.json').targets['build-web'];
    expect(web.options).toEqual({ target: 'web', dist: 'dist/r' });
    expect(web.configurations).toEqual({ prod: { env: 'prod', baseHref: '/r/' } });
    expect(readJson(ws, 'environments/resources/environment.prod.json')).toEqual({ A: 1 });
    expect(exists(ws, 'apps/resources/env/production.json')).toBe(true);
    expect(read(ws, 'docs/migrations/adopt.md')).toContain('kept: another target still uses it');
  });

  it('does not read a PUBLIC_* list as the keys to encrypt', () => {
    const ws = tmpDir();
    fs.mkdirSync(path.join(ws, 'tools'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'tools/encrypt-env.js'),
      "const PUBLIC_ENV_KEYS = ['production'];\nCryptoJS.AES.encrypt(v, c);\n",
    );
    expect(detectSourceEnvEncryption(ws)).toBeUndefined();
  });
});
