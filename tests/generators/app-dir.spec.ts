import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import appGenerator from '../../src/generators/app/generator';
import envGenerator from '../../src/generators/env/generator';

const read = (tree: Tree, p: string): string => tree.read(p, 'utf-8') as string;

describe('app generator --dir', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: {}, devDependencies: { nx: '17.0.6' } }));
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it('puts an Angular app in apps/legacy/portal with depth-aware paths', async () => {
    await appGenerator(tree, { name: 'portal', type: 'angular', dir: 'legacy' });
    const root = 'apps/legacy/portal';
    expect(tree.exists('apps/portal')).toBe(false);

    const pj = readJson(tree, `${root}/project.json`);
    expect(pj.name).toBe('portal');
    expect(pj.$schema).toBe('../../../node_modules/nx/schemas/project-schema.json');
    expect(pj.sourceRoot).toBe(`${root}/src`);
    const build = pj.targets.build.options;
    expect(build.outputPath).toBe('dist/apps/legacy/portal');
    expect(build.index).toBe(`${root}/src/index.html`);
    expect(build.main).toBe(`${root}/src/main.ts`);
    expect(build.tsConfig).toBe(`${root}/tsconfig.app.json`);
    expect(build.assets[0].input).toBe('libs/shared/assets');
    expect(tree.exists(`${root}/src/.htaccess`)).toBe(false);
    expect(tree.exists('environments/portal/htaccess.uat')).toBe(true);
    expect(pj.targets.clean.options.paths).toEqual([
      'dist/apps/legacy/portal',
      'coverage/apps/legacy/portal',
    ]);
    expect(build.styles).toEqual([`${root}/src/styles.scss`]);
    expect(pj.targets.release.options.outputPath).toBe('dist/apps/legacy/portal');
    expect(pj.targets.lint.options.lintFilePatterns).toEqual([
      `${root}/src/**/*.ts`,
      `${root}/src/**/*.html`,
    ]);
    expect(pj.tags).toEqual(['scope:app', 'type:app', 'platform:web']);

    expect(readJson(tree, `${root}/tsconfig.json`).extends).toBe('../../../tsconfig.base.json');
    expect(readJson(tree, `${root}/tsconfig.app.json`).compilerOptions.outDir).toBe(
      '../../../dist/out-tsc',
    );
    expect(readJson(tree, `${root}/tsconfig.spec.json`).compilerOptions.outDir).toBe(
      '../../../dist/out-tsc',
    );
    expect(readJson(tree, `${root}/.eslintrc.json`).extends[0]).toBe('../../../.eslintrc.json');
    expect(read(tree, `${root}/src/main.ts`)).toContain("from '@env/portal/environment'");
    const readme = read(tree, `${root}/server/README.md`);
    expect(readme).toContain('COPY dist/apps/legacy/portal/ /usr/share/nginx/html/');
    expect(readme).toContain(`COPY ${root}/server/nginx.conf`);
    expect(readme).toContain(`\`${root}/csp-allowlist.json\``);

    expect(tree.exists('environments/portal/environment.ts')).toBe(true);
    expect(
      readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@mouryaamit/portal'],
    ).toEqual([`${root}/src`]);
    expect(readJson(tree, 'package.json').scripts['build:portal:prod']).toBe(
      'nx run portal:release:prod',
    );
  });

  it('puts an Ionic app in apps/mobile/field-ops with its own webDir', async () => {
    await appGenerator(tree, { name: 'field-ops', type: 'ionic', dir: 'mobile' });
    const root = 'apps/mobile/field-ops';
    const pj = readJson(tree, `${root}/project.json`);
    expect(pj.targets.release.options.outputPath).toBe('dist/apps/mobile/field-ops');
    for (const command of ['sync', 'open', 'add']) {
      expect(pj.targets[`cap-${command}`].options).toEqual({
        command,
        webDir: 'dist/apps/mobile/field-ops',
      });
    }
    const cap = read(tree, `${root}/capacitor.config.ts`);
    expect(cap).toContain("webDir: '../../../dist/apps/mobile/field-ops'");
    expect(cap).toContain(`(${root}/)`);
    expect(readJson(tree, `${root}/tsconfig.json`).extends).toBe('../../../tsconfig.base.json');
    expect(readJson(tree, `${root}/.eslintrc.json`).extends[0]).toBe('../../../.eslintrc.json');
    expect(read(tree, `${root}/src/main.ts`)).toContain("from '@env/field-ops/environment'");
    expect(tree.exists(`${root}/package.json`)).toBe(true);
  });

  it('puts a Flutter app three folders deep with root-aware targets and files', async () => {
    await appGenerator(tree, {
      name: 'notes',
      type: 'flutter',
      dir: 'a/b/c',
      i18n: ['en'],
      push: 'fcm',
    });
    const root = 'apps/a/b/c/notes';
    const pj = readJson(tree, `${root}/project.json`);
    expect(pj.$schema).toBe('../../../../../node_modules/nx/schemas/project-schema.json');
    expect(pj.sourceRoot).toBe(`${root}/lib`);
    expect(pj.targets['build-web'].options.dist).toBe(`dist/${root}/web`);
    expect(pj.targets.export.options.dest).toBe(root);
    for (const f of [
      'pubspec.yaml',
      'lib/main.dart',
      'web/index.html',
      'lib/l10n/app_en.arb',
      'l10n.yaml',
      'lib/notifications.dart',
    ]) {
      expect(tree.exists(`${root}/${f}`)).toBe(true);
    }
    expect(tree.exists('apps/notes')).toBe(false);
    expect(tree.exists('environments/notes/environment.dev.json')).toBe(true);
    expect(tree.exists('environments/notes/htaccess.prod')).toBe(true);
  });

  it('pstack env and the AI-assistant block find the nested apps', async () => {
    tree.write(
      'CLAUDE.md',
      '# CLAUDE.md\n\n<!-- nx-polystack:start -->\n<!-- nx-polystack:end -->\n',
    );
    await appGenerator(tree, { name: 'portal', type: 'angular', dir: 'legacy' });
    await appGenerator(tree, { name: 'notes', type: 'flutter', dir: 'legacy' });
    expect(read(tree, 'CLAUDE.md')).toContain('`apps/legacy/notes`');
    await envGenerator(tree, { all: true, name: 'qa' });
    expect(tree.exists('environments/notes/environment.qa.json')).toBe(true);
    expect(tree.exists('environments/notes/htaccess.qa')).toBe(true);
    expect(
      readJson(tree, 'apps/legacy/portal/project.json').targets.build.configurations.qa,
    ).toBeDefined();
  });

  it.each([
    ['../up', 'must be kebab-case folder names'],
    ['a/b/c/d', 'is too deep'],
    ['legacy/dist', 'uses "dist"'],
  ])('refuses --dir=%j', async (dir, message) => {
    await expect(appGenerator(tree, { name: 'portal', type: 'angular', dir })).rejects.toThrow(
      `app generator: --dir="${dir}" ${message}`,
    );
  });

  it('refuses a dir that goes through another project', async () => {
    await appGenerator(tree, { name: 'web', type: 'angular' });
    await expect(
      appGenerator(tree, { name: 'portal', type: 'angular', dir: 'web' }),
    ).rejects.toThrow('app generator: --dir="web" goes through the project in "apps/web"');
  });

  it('refuses a name another project already uses, in any folder', async () => {
    await appGenerator(tree, { name: 'portal', type: 'angular' });
    await expect(
      appGenerator(tree, { name: 'portal', type: 'flutter', dir: 'legacy' }),
    ).rejects.toThrow('app generator: a project named "portal" already exists');
    await expect(
      appGenerator(tree, { name: 'portal', type: 'angular', dir: 'other' }),
    ).rejects.toThrow('a project named "portal" already exists');
    tree.write('libs/shared/project.json', JSON.stringify({ name: 'shared' }));
    await expect(appGenerator(tree, { name: 'shared', type: 'angular' })).rejects.toThrow(
      'a project named "shared" already exists',
    );
  });

  it('refuses a name taken by a lib without a name field, or by a root project', async () => {
    tree.write('libs/ui/project.json', '{}');
    await expect(appGenerator(tree, { name: 'ui', type: 'angular' })).rejects.toThrow(
      'a project named "ui" already exists',
    );
    tree.write('project.json', JSON.stringify({ name: 'root-app' }));
    await expect(appGenerator(tree, { name: 'root-app', type: 'flutter' })).rejects.toThrow(
      'a project named "root-app" already exists',
    );
  });

  it('refuses a name whose folder already holds nested apps', async () => {
    await appGenerator(tree, { name: 'portal', type: 'flutter', dir: 'legacy' });
    await expect(appGenerator(tree, { name: 'legacy', type: 'flutter' })).rejects.toThrow(
      'app generator: "apps/legacy" already exists. Pick another --name or --dir.',
    );
  });

  it('pstack env adds the cap-sync scripts for a nested Ionic app', async () => {
    await appGenerator(tree, { name: 'field-ops', type: 'ionic', dir: 'mobile' });
    await envGenerator(tree, { all: true, name: 'qa' });
    const scripts = readJson(tree, 'package.json').scripts;
    expect(scripts['build:field-ops:qa:android']).toContain('cap-sync --platform=android');
  });
});

describe('app generator env imports (NX-83)', () => {
  it('adds the @env/* alias and imports the env file through it', async () => {
    const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: {}, devDependencies: { nx: '17.0.6' } }));
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    await appGenerator(tree, { name: 'web', type: 'angular' });
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@env/*']).toEqual([
      'environments/*',
    ]);
    expect(read(tree, 'apps/web/src/main.ts')).toContain("from '@env/web/environment'");
  });

  it('falls back to a relative import when @env/* maps elsewhere', async () => {
    const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: {}, devDependencies: { nx: '17.0.6' } }));
    tree.write(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: { paths: { '@env/*': ['src/env/*'] } } }),
    );
    await appGenerator(tree, { name: 'web', type: 'angular' });
    expect(read(tree, 'apps/web/src/main.ts')).toContain(
      "from '../../../environments/web/environment'",
    );
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@env/*']).toEqual([
      'src/env/*',
    ]);
  });

  it('app --from moves @env/<base> imports to the new app', async () => {
    const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: {}, devDependencies: { nx: '17.0.6' } }));
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    await appGenerator(tree, { name: 'web', type: 'angular' });
    tree.write(
      'apps/web/src/app/extra.ts',
      "import { environment } from '@env/web/environment';\nexport const e = environment;\n",
    );
    await appGenerator(tree, { name: 'admin', type: 'angular', from: 'web' });
    expect(read(tree, 'apps/admin/src/main.ts')).toContain("from '@env/admin/environment'");
    expect(read(tree, 'apps/admin/src/app/extra.ts')).toContain("from '@env/admin/environment'");
  });
});
