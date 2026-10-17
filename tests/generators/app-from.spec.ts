import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { appFrom, appFromReport, describeBaseApp } from '../../src/generators/app/from';
import appGenerator from '../../src/generators/app/generator';
import envGenerator from '../../src/generators/env/generator';

const read = (tree: Tree, f: string) => tree.read(f, 'utf-8') ?? '';
const json = (tree: Tree, f: string) => JSON.parse(read(tree, f));

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write('package.json', JSON.stringify({ scripts: {} }));
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  return tree;
}

describe('pstack app --from (NX-66)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('Angular', () => {
    let tree: Tree;
    beforeEach(async () => {
      tree = workspace();
      await appGenerator(tree, { name: 'web', type: 'angular', baseHref: '/web/', port: 4200 });
      await envGenerator(tree, { name: 'qa', projects: ['web'] });
      tree.write(
        'environments/web/environment.uat.ts',
        [
          'export const environment = {',
          '  production: false,',
          "  envName: 'uat',",
          "  apiBaseUrl: 'https://uat.example.com',",
          '  password: ENC(abc),',
          '  features: { chat: true, max: 3 },',
          '};',
          '',
        ].join('\n'),
      );
      tree.write('apps/web/src/app/feature/data.json', '{"a":1}');
      tree.write('apps/web/src/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
      tree.write('apps/web/.env', 'TOKEN=x');
      tree.write('apps/web/dist/main.js', 'built');
      tree.write('apps/web/src/app/app.component.ts', '// web home\nexport class Web {}\n');
      const pj = json(tree, 'apps/web/project.json');
      pj.targets.release.configurations.prod.domains = ['web.example.com'];
      pj.targets.release.configurations.prod.includeWww = true;
      tree.write('apps/web/project.json', JSON.stringify(pj, null, 2));
      tree.write(
        'nx.json',
        JSON.stringify({
          ...json(tree, 'nx.json'),
          pstack: { envEncryption: { mode: 'listed', keys: { web: ['password'] } } },
        }),
      );
    });

    it('describes the base app for the questions', () => {
      expect(describeBaseApp(tree, 'web')).toMatchObject({
        type: 'angular',
        root: 'apps/web',
        dir: undefined,
        envs: ['dev', 'uat', 'prod', 'qa'],
        devEnv: 'dev',
        baseHref: true,
        envProject: 'web',
      });
    });

    it('copies the app under the new name with every env value emptied', () => {
      const r = appFrom(tree, { from: 'web', name: 'partner-portal' });
      expect(r.root).toBe('apps/partner-portal');
      expect(read(tree, 'apps/partner-portal/src/app/feature/data.json')).toBe('{"a":1}');
      expect(tree.read('apps/partner-portal/src/logo.png')).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
      );
      expect(tree.exists('apps/partner-portal/.env')).toBe(false);
      expect(r.secrets).toEqual(['.env']);
      expect(tree.exists('apps/partner-portal/dist')).toBe(false);
      expect(read(tree, 'environments/partner-portal/environment.uat.ts')).toBe(
        [
          'export const environment = {',
          '  production: false,',
          "  envName: '',",
          "  apiBaseUrl: '',",
          "  password: '',",
          '  features: { chat: false, max: 0 },',
          '};',
          '',
        ].join('\n'),
      );
      expect(read(tree, 'environments/partner-portal/environment.prod.ts')).toContain(
        'production: false',
      );
      expect(r.envFiles.sort()).toEqual([
        'environments/partner-portal/environment.prod.ts',
        'environments/partner-portal/environment.qa.ts',
        'environments/partner-portal/environment.ts',
        'environments/partner-portal/environment.uat.ts',
      ]);
      expect(r.expressions).toEqual(['environments/partner-portal/environment.uat.ts: password']);
      expect(read(tree, 'environments/web/environment.uat.ts')).toContain('uat.example.com');
    });

    it('renames project.json, sets port and base href, drops the domain lock', () => {
      const r = appFrom(tree, { from: 'web', name: 'partner-portal' });
      const pj = json(tree, 'apps/partner-portal/project.json');
      expect(pj.name).toBe('partner-portal');
      expect(pj.targets.build.options.main).toBe('apps/partner-portal/src/main.ts');
      expect(pj.targets.build.options.outputPath).toBe('dist/apps/partner-portal');
      expect(pj.targets.build.configurations.uat.fileReplacements).toEqual([
        {
          replace: 'environments/partner-portal/environment.ts',
          with: 'environments/partner-portal/environment.uat.ts',
        },
      ]);
      expect(pj.targets.serve.configurations.uat.browserTarget).toBe('partner-portal:build:uat');
      expect(pj.targets.serve.options.port).toBe(4201);
      expect(r.port).toBe(4201);
      expect(pj.targets.release.options.envProject).toBe('partner-portal');
      expect(pj.targets.release.options.buildTarget).toBe('partner-portal:build');
      expect(pj.targets.release.configurations.prod.baseHref).toBe('/partner-portal/');
      expect(pj.targets.release.configurations.prod.domains).toBeUndefined();
      expect(pj.targets.release.configurations.prod.includeWww).toBeUndefined();
      expect(pj.targets.release.configurations.prod.leakCheck).toBe('fail');
      expect(pj.targets.clean.options.paths).toContain('dist/apps/partner-portal');
      expect(pj.tags).toEqual(json(tree, 'apps/web/project.json').tags);
      expect(
        json(tree, 'apps/web/project.json').targets.release.configurations.prod.domains,
      ).toEqual(['web.example.com']);
    });

    it('renames the title, regenerates the server configs, copies keys, aliases and scripts', () => {
      const r = appFrom(tree, { from: 'web', name: 'partner-portal' });
      expect(read(tree, 'apps/partner-portal/src/index.html')).toContain(
        '<title>Partner Portal</title>',
      );
      expect(read(tree, 'apps/partner-portal/src/.htaccess')).toContain('partner-portal');
      expect(read(tree, 'apps/partner-portal/src/.htaccess')).not.toMatch(/\bweb\b/);
      expect(json(tree, 'nx.json').pstack.envEncryption.keys['partner-portal']).toEqual([
        'password',
      ]);
      expect(
        json(tree, 'tsconfig.base.json').compilerOptions.paths['@mouryaamit/partner-portal'],
      ).toEqual(['apps/partner-portal/src']);
      const scripts = json(tree, 'package.json').scripts;
      expect(scripts['serve:partner-portal']).toBe('nx serve partner-portal');
      expect(scripts['build:partner-portal:uat']).toBe('nx run partner-portal:release:uat');
      expect(r.scripts).toContain('build:partner-portal:prod:secure');
      expect(r.leftovers).toContainEqual({
        file: 'apps/partner-portal/src/app/app.component.ts',
        line: 1,
        text: '// web home',
      });
    });

    it('leaves out environments (dev always kept) with their configurations and scripts', () => {
      const r = appFrom(tree, { from: 'web', name: 'lite', envs: ['prod'] });
      expect(r.envs).toEqual(['dev', 'prod']);
      expect(r.leftOut).toEqual(['uat', 'qa']);
      expect(tree.exists('environments/lite/environment.uat.ts')).toBe(false);
      expect(tree.exists('environments/lite/environment.qa.ts')).toBe(false);
      expect(tree.exists('environments/lite/environment.ts')).toBe(true);
      const pj = json(tree, 'apps/lite/project.json');
      expect(Object.keys(pj.targets.release.configurations).sort()).toEqual(['dev', 'prod']);
      expect(Object.keys(pj.targets.build.configurations).sort()).toEqual([
        'development',
        'production',
      ]);
      expect(pj.targets.serve.configurations.uat).toBeUndefined();
      expect(json(tree, 'package.json').scripts['build:lite:uat']).toBeUndefined();
      expect(json(tree, 'package.json').scripts['build:lite:prod']).toBeDefined();
    });

    it('puts the app in another folder and fixes the relative paths', () => {
      appFrom(tree, { from: 'web', name: 'legacy-web', dir: 'legacy', baseHref: null });
      const tsconfig = json(tree, 'apps/legacy/legacy-web/tsconfig.json');
      expect(tsconfig.extends).toBe('../../../tsconfig.base.json');
      const pj = json(tree, 'apps/legacy/legacy-web/project.json');
      expect(pj.$schema).toBe('../../../node_modules/nx/schemas/project-schema.json');
      expect(pj.targets.release.configurations.prod.baseHref).toBeUndefined();
    });

    it('refuses an existing name, a used port, an unknown env and a non-plugin app', () => {
      expect(() => appFrom(tree, { from: 'web', name: 'web' })).toThrow(/other than "web"/);
      expect(() => appFrom(tree, { from: 'web', name: 'x', port: 4200 })).toThrow(
        /port 4200 is used by web/,
      );
      expect(() => appFrom(tree, { from: 'web', name: 'x', envs: ['sit'] })).toThrow(
        /no environment sit/,
      );
      tree.write('libs/ui/project.json', JSON.stringify({ name: 'ui', targets: {} }));
      expect(() => appFrom(tree, { from: 'ui', name: 'x' })).toThrow(/not an app pstack builds/);
      expect(() => appFrom(tree, { from: 'nope', name: 'x' })).toThrow(/no project named "nope"/);
      appFrom(tree, { from: 'web', name: 'b' });
      expect(() => appFrom(tree, { from: 'web', name: 'b' })).toThrow(/already exists/);
    });

    it('clears the CSP allowlist on request', () => {
      tree.write(
        'apps/web/csp-allowlist.json',
        JSON.stringify({ 'connect-src': ['https://api.example.com'] }),
      );
      appFrom(tree, { from: 'web', name: 'b', csp: 'clear' });
      expect(read(tree, 'apps/b/csp-allowlist.json')).not.toContain('api.example.com');
      appFrom(tree, { from: 'web', name: 'c' });
      expect(read(tree, 'apps/c/csp-allowlist.json')).toContain('api.example.com');
    });

    it('leaves out what the .gitignore files ignore (no git work tree)', () => {
      tree.write('.gitignore', '*.log\n/apps/web/src/generated/\n');
      tree.write('apps/web/.gitignore', 'local/\n');
      tree.write('apps/web/debug.log', 'x');
      tree.write('apps/web/local/notes.txt', 'x');
      tree.write('apps/web/src/generated/api.ts', 'x');
      const r = appFrom(tree, { from: 'web', name: 'b' });
      expect(tree.exists('apps/b/debug.log')).toBe(false);
      expect(tree.exists('apps/b/local/notes.txt')).toBe(false);
      expect(tree.exists('apps/b/src/generated/api.ts')).toBe(false);
      expect(tree.exists('apps/b/.gitignore')).toBe(true);
      expect(r.skipped).toEqual(
        expect.arrayContaining(['debug.log', 'local/notes.txt', 'src/generated/api.ts']),
      );
    });

    it('runs through the app generator (nx g … :app --from), envs as a list string', async () => {
      await appGenerator(tree, { name: 'b', type: 'flutter', from: 'web', envs: 'prod' });
      const pj = json(tree, 'apps/b/project.json');
      expect(Object.keys(pj.targets.release.configurations)).toEqual(['dev', 'prod']);
      expect(tree.exists('apps/b/src/main.ts')).toBe(true);
    });

    it('keeps env helper files and build-only env files; reports env files it cannot empty', () => {
      tree.write('environments/web/environment.model.ts', 'export interface Env { a: string }\n');
      tree.write(
        'environments/web/environment.local.ts',
        "export const environment = { apiUrl: 'http://localhost:3000' };\n",
      );
      tree.write(
        'environments/web/environment.qa.ts',
        "export const environment = Object.freeze({ apiUrl: 'https://qa.example.com' });\n",
      );
      const r = appFrom(tree, { from: 'web', name: 'b' });
      expect(read(tree, 'environments/b/environment.model.ts')).toContain('interface Env');
      expect(read(tree, 'environments/b/environment.local.ts')).toContain("apiUrl: ''");
      expect(r.notEmptied).toEqual(['environments/b/environment.qa.ts']);
      expect(appFromReport(r)).toContain('NOT emptied');
      const r2 = appFrom(tree, { from: 'web', name: 'c', envs: ['uat'] });
      expect(tree.exists('environments/c/environment.local.ts')).toBe(true);
      expect(tree.exists('environments/c/environment.qa.ts')).toBe(false);
      expect(tree.exists('environments/c/environment.prod.ts')).toBe(false);
      expect(r2.leftOut).toEqual(['prod', 'qa']);
    });

    it('drops a default configuration that was left out', () => {
      appFrom(tree, { from: 'web', name: 'b', envs: ['uat'] });
      const pj = json(tree, 'apps/b/project.json');
      expect(pj.targets.build.configurations.production).toBeUndefined();
      expect(pj.targets.build.defaultConfiguration).toBeUndefined();
      expect(pj.targets.serve.defaultConfiguration).toBe('development');
      expect(pj.targets.release.defaultConfiguration).toBe('dev');
    });

    it('refuses an environments/<name> folder in use', () => {
      tree.write('environments/b/environment.ts', 'export const environment = {};\n');
      expect(() => appFrom(tree, { from: 'web', name: 'b' })).toThrow(
        /environments\/b is already in use/,
      );
    });

    it('--dir=. puts the app at the top of apps/ when the base app is in a folder', async () => {
      await appGenerator(tree, { name: 'old', type: 'angular', dir: 'legacy', port: 4290 });
      expect(describeBaseApp(tree, 'old').dir).toBe('legacy');
      appFrom(tree, { from: 'old', name: 'same-folder' });
      expect(tree.exists('apps/legacy/same-folder/project.json')).toBe(true);
      appFrom(tree, { from: 'old', name: 'top', dir: '.' });
      expect(tree.exists('apps/top/project.json')).toBe(true);
      expect(json(tree, 'apps/top/tsconfig.json').extends).toBe('../../tsconfig.base.json');
    });

    it('--csp=clear keeps a custom permissions policy', () => {
      tree.write(
        'apps/web/csp-allowlist.json',
        JSON.stringify({
          'connect-src': ['https://api.example.com'],
          'permissions-policy': 'camera=(self)',
        }),
      );
      appFrom(tree, { from: 'web', name: 'b', csp: 'clear' });
      const allowlist = read(tree, 'apps/b/csp-allowlist.json');
      expect(allowlist).not.toContain('api.example.com');
      expect(allowlist).toContain('camera=(self)');
    });

    it('report names the next steps', () => {
      const r = appFrom(tree, { from: 'web', name: 'partner-portal' });
      const report = appFromReport(r);
      expect(report).toContain('partner-portal (apps/partner-portal) from web');
      expect(report).toContain('environments/partner-portal/');
      expect(report).toContain('Not copied (possible secrets): .env');
      expect(report).toContain('nx run partner-portal:serve');
    });
  });

  it('Angular per-env layout keeps the layout', async () => {
    const tree = workspace();
    await appGenerator(tree, { name: 'web', type: 'angular', envLayout: 'per-env' });
    appFrom(tree, { from: 'web', name: 'copy' });
    expect(tree.exists('environments/copy/environment.dev.ts')).toBe(true);
    expect(tree.exists('environments/copy/environment.ts')).toBe(false);
    const pj = json(tree, 'apps/copy/project.json');
    expect(pj.targets.build.configurations.development.fileReplacements).toEqual([
      { replace: 'environments/environment.ts', with: 'environments/copy/environment.dev.ts' },
    ]);
  });

  it('Ionic: new appId (never the base one), appName and native package name', async () => {
    const tree = workspace();
    await appGenerator(tree, { name: 'field', type: 'ionic', appId: 'com.acme.field' });
    expect(describeBaseApp(tree, 'field')).toMatchObject({
      type: 'ionic',
      appId: 'com.acme.field',
    });
    expect(() => appFrom(tree, { from: 'field', name: 'x', appId: 'com.acme.field' })).toThrow(
      /must differ/,
    );
    tree.write('apps/field/android/app/build.gradle', 'applicationId "com.acme.field"');
    const r = appFrom(tree, { from: 'field', name: 'field-ops' });
    expect(tree.exists('apps/field-ops/android')).toBe(false);
    expect(appFromReport(r)).toContain('nx run field-ops:cap-add --platform=android|ios');
    expect(r.appId).toBe('com.example.fieldops');
    const cap = read(tree, 'apps/field-ops/capacitor.config.ts');
    expect(cap).toContain("appId: 'com.example.fieldops'");
    expect(cap).toContain("appName: 'Field Ops'");
    expect(cap).toContain("webDir: '../../dist/apps/field-ops'");
    expect(json(tree, 'apps/field-ops/package.json').name).toBe('field-ops-native');
  });

  it('Flutter: package name and imports, env JSON emptied, left-out envs', async () => {
    const tree = workspace();
    await appGenerator(tree, { name: 'notes', type: 'flutter' });
    tree.write('apps/notes/lib/home.dart', "import 'package:notes/src/x.dart';\n");
    tree.write('apps/notes/build/app.apk', 'x');
    const r = appFrom(tree, { from: 'notes', name: 'notes-lite', envs: ['dev', 'prod'] });
    expect(read(tree, 'apps/notes-lite/pubspec.yaml')).toMatch(/^name: notes_lite$/m);
    expect(read(tree, 'apps/notes-lite/lib/home.dart')).toBe(
      "import 'package:notes_lite/src/x.dart';\n",
    );
    expect(json(tree, 'apps/notes-lite/env/prod.json')).toEqual({
      FLUTTER_ENV: '',
      API_BASE_URL: '',
    });
    expect(tree.exists('apps/notes-lite/env/uat.json')).toBe(false);
    expect(tree.exists('apps/notes-lite/build')).toBe(false);
    const pj = json(tree, 'apps/notes-lite/project.json');
    expect(Object.keys(pj.targets['build-web'].configurations)).toEqual(['dev', 'prod']);
    expect(pj.targets['build-web'].options.dist).toBe('dist/apps/notes-lite/web');
    expect(pj.targets.export.options.dest).toBe('apps/notes-lite');
    expect(read(tree, 'apps/notes-lite/web/index.html')).toContain('<title>Notes Lite</title>');
    expect(r.leftOut).toEqual(['uat']);
  });
});
