import { readFileSync as readFile, writeFileSync } from 'fs';

import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrateGenerator from '../../../src/generators/migrate/generator';

import { fixtureCopy, put, putJson, readJsonFile, snapshot } from './helpers';

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({
      name: '@acme/workspace',
      scripts: { lint: 'nx run-many -t lint', prepare: 'husky' },
      devDependencies: { nx: '~17.0.6', '@nx/eslint': '~17.0.6' },
      engines: { node: '>=18' },
    }),
  );
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  tree.write('tools/config/encrypt-keys.json', '{}\n');
  tree.write('tools/types/global.d.ts', '// workspace typings\n');
  return tree;
}

const readFileSync = (p: string) => readFile(p, 'utf8');
const report = (tree: Tree) => tree.read('docs/migrations/multi.md', 'utf8') as string;

describe('migrate generator: Nx 15 multi-app source', () => {
  let tree: Tree;
  let src: string;

  beforeEach(async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    src = fixtureCopy('nx15-multi-app');
    tree = workspace();
  });
  afterEach(() => jest.restoreAllMocks());

  it('copies the folders the apps use that are not projects, to the same paths', async () => {
    const before = snapshot(src);
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(snapshot(src)).toEqual(before);
    for (const f of [
      'libs/assets/images/logo.svg',
      'libs/styles/css/common.css',
      'environments/environment.ts',
      'environments/portal/environment.uat.ts',
      'environments/portal/app.profile.ts',
      'tools/scripts/build.js',
      'tools/scripts/csp-nonce-patch.js',
      'tools/scripts/validate-types.js',
    ]) {
      expect(tree.exists(f)).toBe(true);
    }
    // Secrets stay behind; workspace files are kept.
    expect(tree.exists('libs/styles/server.key')).toBe(false);
    expect(tree.read('tools/types/global.d.ts', 'utf8')).toBe('// workspace typings\n');
    expect(tree.read('tools/config/encrypt-keys.json', 'utf8')).toBe('{}\n');
    const r = report(tree);
    expect(r).toContain('`libs/styles/server.key`');
    expect(r).toContain('`libs/assets` (1 file; assets of admin; assets of portal)');
    expect(r).toContain('`environments` (9 files;');
    expect(r).toContain('kept, not overwritten: `tools/types/global.d.ts`');
    // No longer "outside the copied projects".
    expect(r).not.toContain('options point outside the copied projects');
  });

  it('rewrites the Nx 15 executors and ESLint config', async () => {
    await migrateGenerator(tree, { source: src, name: 'multi' });
    const shared = readJson(tree, 'libs/shared/project.json');
    expect(shared.targets.lint.executor).toBe('@nx/eslint:lint');
    expect(shared.targets.test.executor).toBe('@nx/jest:jest');
    expect(readJson(tree, 'apps/portal/project.json').targets.lint.executor).toBe(
      '@nx/eslint:lint',
    );
    expect(JSON.stringify(readJson(tree, 'apps/portal/.eslintrc.json'))).toContain(
      'plugin:@nx/angular',
    );
    expect(tree.read('jest.preset.js', 'utf8')).toContain('@nx/jest/preset');
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions).toMatchObject({
      baseUrl: '.',
      paths: {
        '@acme/shared': ['libs/shared/src/index.ts'],
        '@acme/shared/*': ['libs/shared/src/*'],
      },
    });
    // Options the workspace base did not set come from the source (strictness, typeRoots, …).
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions).toMatchObject({
      experimentalDecorators: true,
      typeRoots: ['node_modules/@types', 'tools/types'],
    });
    const r = report(tree);
    expect(r).toContain('Added to `tsconfig.base.json` from the source');
    expect(r).toContain('Set `baseUrl: "."` in `tsconfig.base.json`');
    expect(r).toContain('The source used Jest ^28.1.3');
  });

  it('keeps the source build scripts and adds the release target with env folder and base hrefs', async () => {
    await migrateGenerator(tree, { source: src, name: 'multi' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.scripts).toMatchObject({
      lint: 'nx run-many -t lint',
      prepare: 'husky',
      'build:portal:uat': 'node tools/scripts/build.js --project=portal --env=uat',
      'build:admin:prod': 'node tools/scripts/build.js --project=admin --env=prod',
      'serve:portal': 'nx serve portal --port 9201',
      'build:all:prod': 'node tools/scripts/build-all.js prod',
      'build:admin:uat': 'nx run admin:release:uat',
    });
    expect(pkg.overrides).toEqual({
      'legacy-idle': { '@angular/common': '$@angular/common', '@angular/core': '$@angular/core' },
    });
    expect(pkg.browser).toEqual({ path: false });
    expect(pkg.engines).toEqual({ node: '>=18', npm: '>=8.0.0' });

    const release = readJson(tree, 'apps/portal/project.json').targets.release;
    expect(release.options.envProject).toBe('portal');
    expect(release.configurations.prod).toMatchObject({ env: 'PROD', baseHref: '/portal/' });
    expect(release.configurations.uat).toMatchObject({ env: 'UAT', baseHref: '/portal/' });
    expect(release.configurations.dev.baseHref).toBeUndefined();
    const admin = readJson(tree, 'apps/admin/project.json').targets.release;
    expect(admin.configurations.prod.baseHref).toBeUndefined();

    const r = report(tree);
    expect(r).toContain('The source builds its apps through `tools/scripts/build.js`');
    // The fixture's encrypt-env.js is adopted, so the note says encryption and stamping match.
    expect(r).toContain('env encryption is set up to match theirs');
    expect(r).not.toContain('env encryption as they do it');
    expect(r).toContain('Base hrefs for `admin` could not be read');
    expect(r).toContain('`engines.node`');
    expect(r).not.toContain('`overrides` (not carried over)');
    // Only the clashing scripts are listed as not carried over.
    expect(r).toContain("- `lint`: `eslint 'apps/**/*.ts' 'libs/**/*.ts'`");
    expect(r).not.toContain('- `build:portal:uat`:');
  });

  it("does not carry an engines.node range the workspace's Node is outside of", async () => {
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/workspace', scripts: {}, devDependencies: { nx: '~17.0.6' } }),
    );
    tree.write('.nvmrc', '20\n');
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(readJson(tree, 'package.json').engines).toEqual({ npm: '>=8.0.0' });
    expect(report(tree)).toContain(
      'sets `engines.node` to `18.x`; it was not carried over because the workspace runs Node 20',
    );
  });

  it('carries a compatible engines.node when the workspace pins Node', async () => {
    const pkgPath = `${src}/package.json`;
    const srcPkg = JSON.parse(readFileSync(pkgPath));
    srcPkg.engines.node = '>=18';
    writeFileSync(pkgPath, JSON.stringify(srcPkg));
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/workspace', scripts: {}, devDependencies: { nx: '~17.0.6' } }),
    );
    tree.write('.nvmrc', '20\n');
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(readJson(tree, 'package.json').engines.node).toBe('>=18');
    expect(report(tree)).not.toContain('was not carried over because the workspace runs Node');
  });

  it('reports an engines.node range it cannot check instead of carrying it', async () => {
    const pkgPath = `${src}/package.json`;
    const srcPkg = JSON.parse(readFileSync(pkgPath));
    srcPkg.engines.node = '~>18';
    writeFileSync(pkgPath, JSON.stringify(srcPkg));
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/workspace', scripts: {}, devDependencies: { nx: '~17.0.6' } }),
    );
    tree.write('.nvmrc', '20\n');
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(readJson(tree, 'package.json').engines.node).toBeUndefined();
    expect(report(tree)).toContain("could not be checked against the workspace's Node 20");
  });

  it('keeps the workspace engines.node when it differs from the source', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/workspace',
        scripts: {},
        devDependencies: { nx: '~17.0.6' },
        engines: { node: '>=20' },
      }),
    );
    tree.write('.nvmrc', '20\n');
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(readJson(tree, 'package.json').engines.node).toBe('>=20');
    const r = report(tree);
    expect(r).toContain('`engines.node`');
    expect(r).not.toContain('it was not carried over');
  });

  it('carries engines.node when the workspace pins no Node', async () => {
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/workspace', scripts: {}, devDependencies: { nx: '~17.0.6' } }),
    );
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(readJson(tree, 'package.json').engines).toEqual({ node: '18.x', npm: '>=8.0.0' });
  });

  it('switches main.ts to the library nonce patch', async () => {
    await migrateGenerator(tree, { source: src, name: 'multi' });
    const main = tree.read('apps/portal/src/main.ts', 'utf8') as string;
    expect(main.split('\n')[0]).toBe(
      "import '@mouryaamit/nx-polystack/runtime/csp-nonce'; // was '../../../tools/scripts/csp-nonce-patch'",
    );
    expect(main).toContain("import '../../../libs/shared/src/config/env-init';");
    expect(report(tree)).toContain(
      'the local CSP nonce patch import was replaced by `@mouryaamit/nx-polystack/runtime/csp-nonce`',
    );
  });

  it('sets env encryption like the source script and wraps its env-secret module', async () => {
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(readJson(tree, 'nx.json').pstack.envEncryption).toMatchObject({
      mode: 'all',
      format: 'enc',
      publicKeys: ['production', 'envName', 'appName', 'product', 'timeStamp'],
      profileFiles: ['app.profile.ts'],
      stamp: { timeField: 'timeStamp', branchField: 'branchName' },
    });
    const secret = tree.read('libs/shared/src/config/env-secret.ts', 'utf8') as string;
    expect(secret).toContain("from '@mouryaamit/nx-polystack/runtime/env-secret'");
    expect(secret).toContain("import { environment } from '@env/environment';");
    for (const fn of [
      'envSecret',
      'decryptEnvValue',
      'getBuildMeta',
      'decryptEnvironment',
      'decryptEnvironmentAsync',
    ]) {
      expect(secret).toContain(`export function ${fn}(`);
    }
    expect(secret).not.toContain('crypto-js');
    expect(tree.read('libs/shared/src/config/env-init.ts', 'utf8')).toContain(
      'decryptEnvironment();',
    );
    const r = report(tree);
    expect(r).toContain(
      'Env encryption: the source encrypts its env files with `tools/scripts/encrypt-env.js`',
    );
    expect(r).toContain('`libs/shared/src/config/env-secret.ts` now wrap');
  });

  it('keeps workspace env encryption settings that were already changed', async () => {
    const nx = readJson(tree, 'nx.json');
    nx.pstack = { envEncryption: { mode: 'listed', keys: { default: ['password'] } } };
    tree.write('nx.json', JSON.stringify(nx));
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(readJson(tree, 'nx.json').pstack.envEncryption).toEqual({
      mode: 'listed',
      keys: { default: ['password'] },
    });
    expect(report(tree)).toContain('so they were kept');
  });

  it('keeps env encryption settings when other apps already build with them', async () => {
    tree.write(
      'apps/web/project.json',
      JSON.stringify({
        name: 'web',
        targets: { release: { executor: '@mouryaamit/nx-polystack:build' } },
      }),
    );
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(readJson(tree, 'nx.json').pstack?.envEncryption?.mode).not.toBe('all');
    expect(report(tree)).toContain('`web` already build with them, so they were kept');
  });

  it('sees release apps outside apps/ and libs/', async () => {
    tree.write(
      'packages/site/project.json',
      JSON.stringify({
        name: 'site',
        targets: { release: { executor: '@mouryaamit/nx-polystack:build' } },
      }),
    );
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(report(tree)).toContain('`site` already build with them');
  });

  it('says when the source script cannot be read', async () => {
    put(
      src,
      'tools/scripts/encrypt-env.js',
      "const BASE = ['a'];\nconst PUBLIC_ENV_KEYS = [...BASE, 'b'];\nconst m = 'ENC(';\n",
    );
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(report(tree)).toContain('public keys list could not be read');
    expect(readJson(tree, 'nx.json').pstack?.envEncryption?.mode).not.toBe('all');
  });

  it('keeps an env-secret module with destructured exports', async () => {
    const original = readFileSync(`${src}/libs/shared/src/config/env-secret.ts`);
    put(
      src,
      'libs/shared/src/config/env-secret.ts',
      `${original}\nexport const { a, b } = { a: 1, b: 2 };\n`,
    );
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(tree.read('libs/shared/src/config/env-secret.ts', 'utf8')).toContain('crypto-js');
  });

  it('keeps an env-secret module that exports more than the wrapper keeps', async () => {
    const original = readFileSync(`${src}/libs/shared/src/config/env-secret.ts`);
    put(
      src,
      'libs/shared/src/config/env-secret.ts',
      `${original}\nexport const ENC_OPEN = 'ENC(';\n`,
    );
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(tree.read('libs/shared/src/config/env-secret.ts', 'utf8')).toContain('crypto-js');
    expect(report(tree)).toContain('decrypt env values their own way and were kept');
  });

  it('keeps an env-secret module with a narrower key type', async () => {
    const original = readFileSync(`${src}/libs/shared/src/config/env-secret.ts`);
    put(
      src,
      'libs/shared/src/config/env-secret.ts',
      original.replace(
        'export type EncryptedEnvKey = string;',
        'export type EncryptedEnvKey = keyof typeof environment;',
      ),
    );
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(tree.read('libs/shared/src/config/env-secret.ts', 'utf8')).toContain('crypto-js');
  });

  it('keeps an env-secret module of another shape and says so', async () => {
    put(
      src,
      'libs/shared/src/config/env-secret.ts',
      "import * as CryptoJS from 'crypto-js';\nexport const x = CryptoJS;\n",
    );
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(tree.read('libs/shared/src/config/env-secret.ts', 'utf8')).toContain('export const x');
    expect(report(tree)).toContain('decrypt env values their own way and were kept');
  });

  it('migrates one app with the folders it needs', async () => {
    await migrateGenerator(tree, { source: src, name: 'multi', projects: 'admin' });
    expect(tree.exists('apps/admin/project.json')).toBe(true);
    expect(tree.exists('apps/portal')).toBe(false);
    expect(tree.exists('libs/shared/project.json')).toBe(true);
    expect(tree.exists('environments/admin/environment.prod.ts')).toBe(true);
  });

  it('reads base hrefs from nx build flags', async () => {
    const pkg = readJsonFile<{ scripts: Record<string, string> }>(src, 'package.json');
    pkg.scripts['build:admin:prod'] =
      'nx build admin --configuration=production --base-href /admin/';
    putJson(src, 'package.json', pkg);
    await migrateGenerator(tree, { source: src, name: 'multi' });
    const admin = readJson(tree, 'apps/admin/project.json').targets.release;
    expect(admin.configurations.prod.baseHref).toBe('/admin/');
  });

  it('rolls back cleanly', async () => {
    const pristine = workspace();
    await migrateGenerator(tree, { source: src, name: 'multi' });
    await migrateGenerator(tree, { rollback: 'multi' });
    expect(tree.read('tools/types/global.d.ts', 'utf8')).toBe('// workspace typings\n');
    expect(tree.read('tools/config/encrypt-keys.json', 'utf8')).toBe('{}\n');
    for (const gone of ['libs/assets', 'environments', 'tools/scripts', 'apps/portal']) {
      expect(tree.exists(gone)).toBe(false);
    }
    expect(readJson(tree, 'package.json')).toEqual(readJson(pristine, 'package.json'));
  });

  it("leaves a source's own release target as it is", async () => {
    const pj = readJsonFile<{ targets: Record<string, unknown> }>(src, 'apps/admin/project.json');
    pj.targets['release'] = { executor: 'nx:run-commands', options: { command: 'echo release' } };
    putJson(src, 'apps/admin/project.json', pj);
    const pkg = readJsonFile<{ scripts: Record<string, string> }>(src, 'package.json');
    pkg.scripts['build:admin:prod'] = 'nx build admin --configuration=production --base-href /a/';
    putJson(src, 'package.json', pkg);
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(readJson(tree, 'apps/admin/project.json').targets.release).toEqual({
      executor: 'nx:run-commands',
      options: { command: 'echo release' },
    });
  });

  it('renames projects in kept scripts with --prefix and drops scripts of projects not imported', async () => {
    await migrateGenerator(tree, { source: src, name: 'multi', prefix: 'x', projects: 'admin' });
    const scripts = readJson(tree, 'package.json').scripts;
    // The custom script looks the source name up itself (base-href maps), so it keeps it.
    expect(scripts['build:admin:prod']).toBe(
      'node tools/scripts/build.js --project=admin --env=prod',
    );
    expect(scripts['test']).toBe('nx test x-shared');
    expect(scripts['build:portal:uat']).toBeUndefined();
    expect(scripts['serve:portal']).toBeUndefined();
    const r = report(tree);
    expect(r).toContain('npm scripts for projects that were not imported were not carried over');
    expect(r).toContain('`serve:portal` (`portal`)');
    expect(r).toContain('Project names were renamed (`--prefix`) in the kept npm scripts');
    expect(r).toContain('pass the source project name to a custom script');
    expect(r).toContain('`build:admin:prod` (`admin` → `x-admin`)');
  });

  it('never carries lifecycle scripts, and copies root files other scripts run', async () => {
    const pkg = readJsonFile<{ scripts: Record<string, string> }>(src, 'package.json');
    pkg.scripts['postinstall'] = 'node ./decorate-angular-cli.js';
    pkg.scripts['postbuild'] = 'node postbuild.js && node tools/scripts/validate-types.js';
    putJson(src, 'package.json', pkg);
    put(src, 'decorate-angular-cli.js', '// patches the cli\n');
    put(src, 'postbuild.js', '// after the build\n');
    await migrateGenerator(tree, { source: src, name: 'multi' });
    const scripts = readJson(tree, 'package.json').scripts;
    expect(scripts['postinstall']).toBeUndefined();
    expect(scripts['postbuild']).toBe('node postbuild.js && node tools/scripts/validate-types.js');
    expect(tree.exists('postbuild.js')).toBe(true);
    expect(tree.exists('decorate-angular-cli.js')).toBe(false);
    const r = report(tree);
    expect(r).toContain('npm lifecycle scripts of the source were not carried over');
    expect(r).toContain('Copied root files the projects or npm scripts use: `postbuild.js`');
  });

  it('follows SCSS imports and reports references into projects that were not selected', async () => {
    put(src, 'libs/theme/_vars.scss', '$x: 1;\n');
    put(src, 'apps/admin/src/styles.scss', "@use '../../../libs/theme/vars';\n");
    put(
      src,
      'apps/admin/src/app/x.ts',
      "import { SharedModule } from '../../../../libs/shared/src/shared.module';\n",
    );
    await migrateGenerator(tree, { source: src, name: 'multi', projects: 'admin', noDeps: true });
    expect(tree.exists('libs/theme/_vars.scss')).toBe(true);
    expect(tree.exists('libs/shared')).toBe(false);
    expect(report(tree)).toContain(
      '`../../../../libs/shared/src/shared.module` (points outside the imported projects)',
    );
  });

  it('notes npm overrides when the workspace uses pnpm', async () => {
    tree.write('pnpm-lock.yaml', 'lockfileVersion: 6.0\n');
    await migrateGenerator(tree, { source: src, name: 'multi' });
    expect(report(tree)).toContain('which ignores npm `overrides`: move them to `pnpm.overrides`');
  });
});
