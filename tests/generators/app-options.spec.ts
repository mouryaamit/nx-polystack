import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import appGenerator from '../../src/generators/app/generator';
import envGenerator from '../../src/generators/env/generator';
import sharedLibsGenerator from '../../src/generators/shared-libs/generator';
import libGenerator from '../../src/generators/lib/generator';
import { nextFreePort, usedServePorts } from '../../src/lib/utils/serve-port';
import { SHARED_ASSETS_IGNORE } from '../../src/lib/utils/shared-libs';

const read = (tree: Tree, p: string): string => tree.read(p, 'utf-8') as string;

describe('app generator options (NX-43)', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: {}, devDependencies: { nx: '17.0.6' } }));
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('dev-server port', () => {
    it('gives each new app the next free port from 4200', async () => {
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      await appGenerator(tree, { name: 'field', type: 'ionic' });
      await appGenerator(tree, { name: 'mobile', type: 'flutter' });
      expect(readJson(tree, 'apps/portal/project.json').targets.serve.options).toEqual({
        port: 4200,
      });
      expect(readJson(tree, 'apps/field/project.json').targets.serve.options.port).toBe(4201);
      expect(readJson(tree, 'apps/mobile/project.json').targets.serve.options).toEqual({
        target: 'web',
        serve: true,
        port: 4202,
      });
    });

    it('takes --port and skips taken ports afterwards', async () => {
      await appGenerator(tree, { name: 'portal', type: 'angular', port: 4300 });
      await appGenerator(tree, { name: 'admin', type: 'angular', port: 4200 });
      await appGenerator(tree, { name: 'reports', type: 'angular' });
      expect(readJson(tree, 'apps/portal/project.json').targets.serve.options.port).toBe(4300);
      expect(readJson(tree, 'apps/reports/project.json').targets.serve.options.port).toBe(4201);
    });

    it('refuses a port another app uses, counting apps without a port as 4200', async () => {
      tree.write(
        'apps/legacy/project.json',
        JSON.stringify({
          name: 'legacy',
          projectType: 'application',
          targets: { serve: { executor: '@angular-devkit/build-angular:dev-server' } },
        }),
      );
      await expect(
        appGenerator(tree, { name: 'portal', type: 'angular', port: 4200 }),
      ).rejects.toThrow('port 4200 is used by legacy (no port set: the 4200 default)');
      expect(tree.exists('apps/portal')).toBe(false);
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      expect(readJson(tree, 'apps/portal/project.json').targets.serve.options.port).toBe(4201);
    });

    it('refuses ports outside 1024-65535', async () => {
      for (const port of [80, 70000, 4200.5]) {
        await expect(appGenerator(tree, { name: 'portal', type: 'angular', port })).rejects.toThrow(
          '--port must be a whole number from 1024 to 65535',
        );
      }
    });

    it('lists used ports and finds the next free one', () => {
      expect(nextFreePort([4200, 4201, 4203])).toBe(4202);
      expect(usedServePorts(tree)).toEqual([]);
    });
  });

  describe('clean target', () => {
    it('cleans dist and coverage of Angular/Ionic apps, plus flutter clean for Flutter', async () => {
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      await appGenerator(tree, { name: 'mobile', type: 'flutter', dir: 'native' });
      expect(readJson(tree, 'apps/portal/project.json').targets.clean).toEqual({
        executor: '@mouryaamit/nx-polystack:clean',
        options: { paths: ['dist/apps/portal', 'coverage/apps/portal'] },
      });
      expect(readJson(tree, 'apps/native/mobile/project.json').targets.clean).toEqual({
        executor: '@mouryaamit/nx-polystack:clean',
        options: {
          paths: ['dist/apps/native/mobile', 'coverage/apps/native/mobile'],
          flutter: true,
        },
      });
      const scripts = readJson(tree, 'package.json').scripts;
      expect(scripts['clean:portal']).toBe('nx run portal:clean');
      expect(scripts['clean:mobile']).toBe('nx run mobile:clean');
    });
  });

  describe('shared assets and styles', () => {
    it('creates the folders once and wires every new Angular/Ionic app', async () => {
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      await appGenerator(tree, { name: 'field', type: 'ionic' });
      expect(readJson(tree, 'libs/shared/assets/project.json')).toMatchObject({
        name: 'shared-assets',
        projectType: 'library',
        tags: ['scope:shared', 'type:assets'],
      });
      expect(readJson(tree, 'libs/shared/styles/project.json').name).toBe('shared-styles');
      expect(read(tree, 'libs/shared/styles/_theme.scss')).toContain('$brand-primary');
      expect(tree.exists('libs/shared/assets/.gitkeep')).toBe(true);

      for (const app of ['portal', 'field']) {
        const pj = readJson(tree, `apps/${app}/project.json`);
        const build = pj.targets.build.options;
        expect(build.assets).toContainEqual({
          glob: '**/*',
          input: 'libs/shared/assets',
          output: 'assets/shared',
          ignore: SHARED_ASSETS_IGNORE,
        });
        expect(build.stylePreprocessorOptions).toEqual({ includePaths: ['libs/shared/styles'] });
        expect(pj.implicitDependencies).toEqual(['shared-assets', 'shared-styles']);
      }
    });

    it("uses a migrated workspace's libs/assets and libs/styles folders as they are", async () => {
      tree.write('libs/assets/images/logo.svg', '<svg/>');
      tree.write('libs/styles/_variables.scss', '$x: 1;');
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      expect(tree.exists('libs/shared')).toBe(false);
      expect(tree.exists('libs/assets/project.json')).toBe(false);
      const pj = readJson(tree, 'apps/portal/project.json');
      expect(pj.targets.build.options.assets[1].input).toBe('libs/assets');
      expect(pj.targets.build.options.stylePreprocessorOptions.includePaths).toEqual([
        'libs/styles',
      ]);
      expect(pj.implicitDependencies).toBeUndefined();
    });

    it('does not wire Flutter apps', async () => {
      await appGenerator(tree, { name: 'mobile', type: 'flutter' });
      expect(tree.exists('libs/shared')).toBe(false);
    });

    it('pstack shared wires existing apps once and reports the rest', async () => {
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      tree.write(
        'apps/legacy/project.json',
        JSON.stringify({
          name: 'legacy',
          projectType: 'application',
          targets: {
            build: {
              executor: '@angular-devkit/build-angular:browser',
              options: { assets: ['apps/legacy/src/favicon.ico'] },
            },
          },
        }),
      );
      tree.write(
        'apps/mobile/project.json',
        JSON.stringify({ name: 'mobile', projectType: 'application', targets: {} }),
      );
      const info = logger.info as jest.Mock;
      await sharedLibsGenerator(tree, { all: true });
      const legacy = readJson(tree, 'apps/legacy/project.json');
      expect(legacy.targets.build.options.assets).toHaveLength(2);
      expect(legacy.implicitDependencies).toEqual(['shared-assets', 'shared-styles']);
      const said = info.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toContain('wired into legacy');
      expect(said).toContain('already wired: portal');

      await expect(sharedLibsGenerator(tree, { projects: ['mobile'] })).rejects.toThrow(
        'mobile: not an Angular/Ionic app',
      );
      await expect(sharedLibsGenerator(tree, { projects: ['nope'] })).rejects.toThrow(
        'nope: no such project',
      );
      await expect(sharedLibsGenerator(tree, {})).rejects.toThrow('name the apps');
    });

    it('skips the project.json when the shared-assets name is taken', async () => {
      tree.write(
        'libs/brand/project.json',
        JSON.stringify({ name: 'shared-assets', projectType: 'library' }),
      );
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      expect(tree.exists('libs/shared/assets/project.json')).toBe(false);
      expect(tree.exists('libs/shared/assets/.gitkeep')).toBe(true);
      expect(readJson(tree, 'apps/portal/project.json').implicitDependencies).toEqual([
        'shared-styles',
      ]);
    });
  });

  describe('robustness (review)', () => {
    it('ignores unreadable and duplicate-named project.json files when scanning', async () => {
      tree.write('tools/templates/project.json', '{ "name": <%= name %> }');
      tree.write('apps/x/e2e/project.json', JSON.stringify({ projectType: 'application' }));
      tree.write('libs/x/e2e/project.json', JSON.stringify({ projectType: 'application' }));
      await appGenerator(tree, { name: 'mobile', type: 'flutter' });
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      expect(readJson(tree, 'apps/portal/project.json').targets.serve.options.port).toBe(4201);
    });

    it('wires assets and styles libs made by pstack lib through their sourceRoot', async () => {
      await libGenerator(tree, { type: 'assets', name: 'assets' } as never);
      await libGenerator(tree, { type: 'styles', name: 'styles' } as never);
      const assetsSrc = readJson(tree, 'libs/shared/assets/project.json').sourceRoot;
      const stylesSrc = readJson(tree, 'libs/shared/styles/project.json').sourceRoot;
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      const pj = readJson(tree, 'apps/portal/project.json');
      const shared = pj.targets.build.options.assets.find(
        (a: { output?: string }) => a.output === 'assets/shared',
      );
      expect(shared.input).toBe(assetsSrc);
      expect(pj.targets.build.options.stylePreprocessorOptions.includePaths).toEqual([stylesSrc]);
      expect(tree.exists('libs/shared/styles/_theme.scss')).toBe(false);
    });

    it('does not nest new folders inside a libs/shared project', async () => {
      tree.write(
        'libs/shared/project.json',
        JSON.stringify({ name: 'shared', projectType: 'library', sourceRoot: 'libs/shared/src' }),
      );
      tree.write('libs/assets/images/logo.svg', '<svg/>');
      await appGenerator(tree, { name: 'portal', type: 'angular' });
      expect(tree.exists('libs/shared/styles')).toBe(false);
      expect(readJson(tree, 'libs/styles/project.json').name).toBe('shared-styles');
      const build = readJson(tree, 'apps/portal/project.json').targets.build.options;
      expect(build.stylePreprocessorOptions.includePaths).toEqual(['libs/styles']);
      expect(build.assets[1].input).toBe('libs/assets');
    });

    it('treats equivalent asset inputs and include paths as already wired', async () => {
      tree.write(
        'apps/legacy/project.json',
        JSON.stringify({
          name: 'legacy',
          projectType: 'application',
          targets: {
            build: {
              executor: '@angular-devkit/build-angular:browser',
              options: {
                assets: [{ glob: '**/*', input: './libs/shared/assets/', output: 'assets' }],
                stylePreprocessorOptions: { includePaths: ['libs/shared/styles/'] },
              },
            },
          },
        }),
      );
      await sharedLibsGenerator(tree, { projects: ['legacy'] });
      const build = readJson(tree, 'apps/legacy/project.json').targets.build.options;
      expect(build.assets).toHaveLength(1);
      expect(build.stylePreprocessorOptions.includePaths).toEqual(['libs/shared/styles/']);
    });
  });

  describe('--envLayout=per-env', () => {
    it('writes environment.dev|uat|prod.ts replacing a shared environments/environment.ts', async () => {
      await appGenerator(tree, { name: 'portal', type: 'angular', envLayout: 'per-env' });
      expect(tree.exists('environments/portal/environment.ts')).toBe(false);
      for (const env of ['dev', 'uat', 'prod']) {
        expect(read(tree, `environments/portal/environment.${env}.ts`)).toContain(
          `envName: '${env}'`,
        );
      }
      expect(read(tree, 'environments/environment.ts')).toContain('Replaced at build time');
      expect(read(tree, 'apps/portal/src/main.ts')).toContain(
        "from '@env/environment'",
      );
      const configs = readJson(tree, 'apps/portal/project.json').targets.build.configurations;
      const repl = (c: string) => configs[c].fileReplacements;
      expect(repl('development')).toEqual([
        { replace: 'environments/environment.ts', with: 'environments/portal/environment.dev.ts' },
      ]);
      expect(repl('uat')).toEqual([
        { replace: 'environments/environment.ts', with: 'environments/portal/environment.uat.ts' },
      ]);
      expect(repl('production')).toEqual([
        { replace: 'environments/environment.ts', with: 'environments/portal/environment.prod.ts' },
      ]);
    });

    it('keeps an existing shared root file and the default layout for other apps', async () => {
      tree.write('environments/environment.ts', 'export const environment = { custom: true };\n');
      await appGenerator(tree, { name: 'portal', type: 'ionic', envLayout: 'per-env' });
      await appGenerator(tree, { name: 'admin', type: 'angular' });
      expect(read(tree, 'environments/environment.ts')).toContain('custom: true');
      expect(read(tree, 'apps/admin/src/main.ts')).toContain(
        "from '@env/admin/environment'",
      );
      expect(tree.exists('environments/admin/environment.ts')).toBe(true);
      const dev = readJson(tree, 'apps/admin/project.json').targets.build.configurations
        .development;
      expect(dev.fileReplacements).toBeUndefined();
    });

    it('pstack env copies the per-env replacement for a new environment', async () => {
      await appGenerator(tree, { name: 'portal', type: 'angular', envLayout: 'per-env' });
      await envGenerator(tree, { name: 'qa', projects: ['portal'] });
      const qa = readJson(tree, 'apps/portal/project.json').targets.build.configurations.qa;
      expect(qa.fileReplacements).toEqual([
        { replace: 'environments/environment.ts', with: 'environments/portal/environment.qa.ts' },
      ]);
      expect(tree.exists('environments/portal/environment.qa.ts')).toBe(true);
    });

    it('rejects an unknown layout', async () => {
      await expect(
        appGenerator(tree, {
          name: 'portal',
          type: 'angular',
          envLayout: 'flat' as unknown as 'per-env',
        }),
      ).rejects.toThrow('--envLayout="flat" is not supported');
    });
  });
});
