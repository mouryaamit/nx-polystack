import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrate from '../../src/migrations/angular-release-target/angular-release-target';

const OLD = (name: string) => ({
  name,
  projectType: 'application',
  targets: {
    build: {
      executor: '@mouryaamit/nx-polystack:build',
      outputs: ['{options.outputPath}'],
      options: { type: 'angular', outputPath: `dist/apps/${name}`, envProject: name },
      configurations: {
        dev: { env: 'DEV' },
        uat: { env: 'UAT' },
        prod: { env: 'PROD' },
        qa: { env: 'QA' },
      },
    },
    serve: {
      executor: '@angular-devkit/build-angular:dev-server',
      configurations: {
        development: { browserTarget: `${name}:build:dev` },
        uat: { browserTarget: `${name}:build:uat` },
        production: { browserTarget: `${name}:build:prod` },
      },
    },
  },
});

function setup(projects: Record<string, unknown>, scripts: Record<string, string> = {}): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(
    'package.json',
    JSON.stringify({ scripts, dependencies: { '@angular/core': '~15.2.0' } }),
  );
  for (const [name, pj] of Object.entries(projects)) {
    tree.write(`apps/${name}/project.json`, JSON.stringify(pj));
  }
  return tree;
}

describe('angular-release-target migration', () => {
  it('moves the old pipeline target to release and writes an Angular build', async () => {
    const tree = setup({ web: OLD('web') });
    await migrate(tree);
    const pj = readJson(tree, 'apps/web/project.json');
    expect(pj.targets.build.executor).toBe('@angular-devkit/build-angular:browser');
    expect(pj.targets.release.executor).toBe('@mouryaamit/nx-polystack:build');
    expect(pj.targets.release.options.buildTarget).toBe('web:build');
    expect(pj.targets.release.configurations).toEqual({
      dev: { env: 'DEV', buildConfiguration: 'development' },
      uat: { env: 'UAT', buildConfiguration: 'uat' },
      prod: { env: 'PROD', buildConfiguration: 'production' },
      qa: { env: 'QA', buildConfiguration: 'qa' },
    });
    expect(pj.targets.build.configurations.qa.fileReplacements).toEqual([
      { replace: 'environments/web/environment.ts', with: 'environments/web/environment.qa.ts' },
    ]);
    expect(pj.targets.release.configurations.qa).toEqual({ env: 'QA', buildConfiguration: 'qa' });
    expect(pj.targets.serve.configurations).toEqual({
      development: { browserTarget: 'web:build:development' },
      uat: { browserTarget: 'web:build:uat' },
      production: { browserTarget: 'web:build:production' },
    });
  });

  it('rewrites the app npm scripts to use release', async () => {
    const tree = setup(
      { web: OLD('web') },
      {
        'build:web:prod': 'nx run web:build:prod',
        'build:web:prod:secure': 'nx run web:build:prod -- --secure',
        'serve:web': 'nx serve web',
      },
    );
    await migrate(tree);
    const { scripts } = readJson(tree, 'package.json');
    expect(scripts['build:web:prod']).toBe('nx run web:release:prod');
    expect(scripts['build:web:prod:secure']).toBe('nx run web:release:prod --secure');
    expect(scripts['serve:web']).toBe('nx serve web');
  });

  it('leaves hand-shaped Angular apps and already-migrated apps alone, and is idempotent', async () => {
    const hand = {
      name: 'mobile',
      targets: {
        build: { executor: '@angular-devkit/build-angular:browser', options: { main: 'x' } },
      },
    };
    const tree = setup({ web: OLD('web'), mobile: hand });
    await migrate(tree);
    const once = readJson(tree, 'apps/web/project.json');
    await migrate(tree);
    expect(readJson(tree, 'apps/web/project.json')).toEqual(once);
    expect(readJson(tree, 'apps/mobile/project.json')).toEqual(hand);
  });

  it('skips a project that already has a release target', async () => {
    const pj = OLD('web') as ReturnType<typeof OLD> & { targets: Record<string, unknown> };
    pj.targets.release = { executor: 'nx:noop' };
    const tree = setup({ web: pj });
    await migrate(tree);
    expect(readJson(tree, 'apps/web/project.json')).toEqual(pj);
  });

  it('adds Angular packages when missing and returns the install callback', async () => {
    const tree = setup({ web: OLD('web') });
    tree.write('package.json', JSON.stringify({ scripts: {} }));
    const cb = await migrate(tree);
    expect(readJson(tree, 'package.json').dependencies['@angular/core']).toBe('~15.2.0');
    expect(typeof cb).toBe('function');
  });

  describe('hardening', () => {
    const scriptsFor = async (
      scripts: Record<string, string>,
      extra: Record<string, unknown> = {},
    ) => {
      const tree = setup({ web: OLD('web'), ...extra }, scripts);
      await migrate(tree);
      return readJson(tree, 'package.json').scripts as Record<string, string>;
    };

    it('rewrites custom config names, prefixed and chained scripts, on boundaries only', async () => {
      const web = OLD('web');
      (web.targets.build.configurations as Record<string, unknown>)['pre-prod'] = {
        env: 'PRE-PROD',
      };
      const tree = setup(
        { web },
        {
          a: 'nx run web:build:pre-prod',
          b: 'cross-env X=1 nx run web:build:prod',
          c: 'nx run web:build:dev && echo ok',
          d: 'nx run web:build:prod -- --secure',
          e: 'nx run web:build:production',
        },
      );
      await migrate(tree);
      const { scripts } = readJson(tree, 'package.json');
      expect(scripts.a).toBe('nx run web:release:pre-prod');
      expect(scripts.b).toBe('cross-env X=1 nx run web:release:prod');
      expect(scripts.c).toBe('nx run web:release:dev && echo ok');
      expect(scripts.d).toBe('nx run web:release:prod --secure');
      expect(scripts.e).toBe('nx run web:build:production');
    });

    it('leaves scripts of a similarly named app untouched', async () => {
      const scripts = await scriptsFor({ x: 'nx run web2:build:prod' });
      expect(scripts.x).toBe('nx run web2:build:prod');
    });

    it('skips apps whose pipeline type is not angular', async () => {
      const ionic = OLD('mob') as ReturnType<typeof OLD>;
      ionic.targets.build.options.type = 'ionic';
      const tree = setup({ mob: ionic });
      await migrate(tree);
      expect(readJson(tree, 'apps/mob/project.json')).toEqual(ionic);
    });

    it('uses the project name for target strings and the folder for paths', async () => {
      const pj = OLD('web-app');
      const tree = setup({ web: pj }, { 'build:web-app:prod': 'nx run web-app:build:prod' });
      await migrate(tree);
      const out = readJson(tree, 'apps/web/project.json');
      expect(out.targets.release.options.buildTarget).toBe('web-app:build');
      expect(out.targets.serve.configurations.production.browserTarget).toBe(
        'web-app:build:production',
      );
      expect(out.targets.build.options.main).toBe('apps/web/src/main.ts');
      expect(readJson(tree, 'package.json').scripts['build:web-app:prod']).toBe(
        'nx run web-app:release:prod',
      );
    });
  });
});
