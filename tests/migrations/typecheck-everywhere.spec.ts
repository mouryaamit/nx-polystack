import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import {
  addTypecheckScript,
  infersTypecheck,
  isAngularProject,
  templatesConfigChange,
} from '../../src/lib/utils/quality';
import typecheckEverywhere from '../../src/migrations/typecheck-everywhere/typecheck-everywhere';

const pkg = (t: Tree) => readJson(t, 'package.json');
const targets = (t: Tree, root: string) => readJson(t, `${root}/project.json`).targets;

describe('typecheck-everywhere migration (NX-111)', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({ name: 'ws', scripts: { lint: 'nx run-many -t lint' } }),
    );
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function angularApp(root: string, extraTargets: Record<string, unknown> = {}) {
    tree.write(
      `${root}/project.json`,
      // A layout pstack does not write: targets on one line each.
      `{\n  "name": "${root
        .split('/')
        .pop()}",\n  "targets": {\n    "build": { "executor": "@angular-devkit/build-angular:browser" }${
        Object.keys(extraTargets).length
          ? `,\n    ${Object.entries(extraTargets)
              .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`)
              .join(',\n    ')}`
          : ''
      }\n  }\n}\n`,
    );
    tree.write(`${root}/tsconfig.app.json`, '{ "extends": "./tsconfig.json" }');
    tree.write(
      `${root}/tsconfig.json`,
      '{ "angularCompilerOptions": { "strictTemplates": true } }',
    );
  }

  it('adds typecheck (with templates) where missing, keeps layouts, analyze on Flutter, root script', async () => {
    angularApp('apps/portal');
    tree.write('libs/util/project.json', JSON.stringify({ name: 'util', targets: {} }, null, 2));
    tree.write('libs/util/tsconfig.lib.json', '{}');
    tree.write('libs/styles/project.json', JSON.stringify({ name: 'styles', targets: {} }));
    tree.write(
      'apps/notes/project.json',
      JSON.stringify({ name: 'notes', targets: { 'build-web': { executor: 'x' } } }),
    );
    tree.write('apps/notes/pubspec.yaml', 'name: notes\n');

    await typecheckEverywhere(tree);

    expect(targets(tree, 'apps/portal').typecheck).toEqual({
      executor: 'nx:run-commands',
      options: { command: 'tsc --noEmit -p apps/portal/tsconfig.app.json' },
      configurations: { templates: { command: 'ngc --noEmit -p apps/portal/tsconfig.app.json' } },
    });
    // Layout kept: the build target is still on one line.
    expect(tree.read('apps/portal/project.json', 'utf8')).toContain(
      '"build": { "executor": "@angular-devkit/build-angular:browser" }',
    );
    // A plain TS lib: no templates configuration.
    expect(targets(tree, 'libs/util').typecheck).toEqual({
      executor: 'nx:run-commands',
      options: { command: 'tsc --noEmit -p libs/util/tsconfig.lib.json' },
    });
    expect(targets(tree, 'libs/styles').typecheck).toBeUndefined();
    expect(targets(tree, 'apps/notes').analyze).toEqual({
      executor: 'nx:run-commands',
      options: { command: 'flutter analyze', cwd: 'apps/notes' },
    });
    expect(targets(tree, 'apps/notes').typecheck).toBeUndefined();
    expect(pkg(tree).scripts.typecheck).toBe('nx run-many -t typecheck');
    expect(readJson(tree, 'nx.json').targetDefaults.typecheck.cache).toBe(true);
  });

  it('adds templates to a typecheck pstack wrote, leaves other typecheck targets, is idempotent', async () => {
    angularApp('apps/portal', {
      typecheck: {
        executor: 'nx:run-commands',
        options: { command: 'tsc --noEmit -p apps/portal/tsconfig.app.json' },
      },
    });
    angularApp('apps/admin', {
      typecheck: { executor: 'nx:run-commands', options: { command: 'node tools/check.js' } },
    });
    await typecheckEverywhere(tree);
    expect(targets(tree, 'apps/portal').typecheck.configurations).toEqual({
      templates: { command: 'ngc --noEmit -p apps/portal/tsconfig.app.json' },
    });
    expect(targets(tree, 'apps/admin').typecheck).toEqual({
      executor: 'nx:run-commands',
      options: { command: 'node tools/check.js' },
    });
    const before = new Map(
      ['apps/portal/project.json', 'apps/admin/project.json', 'package.json', 'nx.json'].map(
        (f) => [f, tree.read(f, 'utf8')],
      ),
    );
    await typecheckEverywhere(tree);
    for (const [f, text] of before) expect(tree.read(f, 'utf8')).toBe(text);
  });

  it('lists a project.json with comments instead of rewriting it', async () => {
    const text = '// portal\n{ "name": "portal", "targets": {} }\n';
    tree.write('apps/portal/project.json', text);
    tree.write('apps/portal/tsconfig.app.json', '{}');
    await typecheckEverywhere(tree);
    expect(tree.read('apps/portal/project.json', 'utf8')).toBe(text);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('apps/portal/project.json hold comments'),
    );
  });

  it('adds no typecheck targets when nx.json infers them (@nx/js/typescript)', async () => {
    tree.write(
      'nx.json',
      JSON.stringify({
        plugins: [
          { plugin: '@nx/js/typescript', options: { typecheck: { targetName: 'typecheck' } } },
        ],
      }),
    );
    tree.write('libs/util/project.json', JSON.stringify({ name: 'util', targets: {} }));
    tree.write('libs/util/tsconfig.lib.json', '{}');
    expect(infersTypecheck(tree)).toBe(true);
    await typecheckEverywhere(tree);
    expect(targets(tree, 'libs/util').typecheck).toBeUndefined();
    expect(pkg(tree).scripts.typecheck).toBeUndefined();
  });

  it('keeps a root typecheck script that does something else', async () => {
    tree.write('package.json', JSON.stringify({ scripts: { typecheck: 'node tools/check.js' } }));
    expect(addTypecheckScript(tree)).toBe('other');
    expect(pkg(tree).scripts.typecheck).toBe('node tools/check.js');
    tree.write(
      'package.json',
      JSON.stringify({ scripts: { typecheck: 'nx run-many --targets=typecheck' } }),
    );
    expect(addTypecheckScript(tree)).toBe('exists');
  });

  it('tells Angular projects from others', () => {
    angularApp('apps/portal');
    expect(isAngularProject(tree, 'apps/portal', {})).toBe(true);
    tree.write('libs/ui/tsconfig.lib.json', '{}');
    expect(
      isAngularProject(tree, 'libs/ui', {
        targets: { build: { executor: '@nx/angular:package' } },
      }),
    ).toBe(true);
    expect(
      isAngularProject(tree, 'libs/ui', { targets: { build: { executor: '@nx/js:tsc' } } }),
    ).toBe(false);
    tree.write('libs/ui/project.json', JSON.stringify({ name: 'ui', targets: {} }));
    expect(templatesConfigChange(tree, 'libs/ui')).toBe('none');
  });
});
