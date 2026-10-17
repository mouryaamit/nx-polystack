import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import libGenerator from '../../src/generators/lib/generator';

const ROOT = 'libs/flutter/shared_core';

describe('lib generator --type=flutter', () => {
  let tree: Tree;
  let info: jest.SpyInstance;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
    );
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => info.mockRestore());

  it('creates a Dart package in a snake_case dir', async () => {
    await libGenerator(tree, { name: 'shared-core', type: 'flutter' });
    const pubspec = tree.read(`${ROOT}/pubspec.yaml`, 'utf8') ?? '';
    expect(pubspec).toContain('name: shared_core');
    expect(pubspec).toContain('publish_to: none');
    expect(pubspec).toContain('version: 0.0.1+1');
    expect(pubspec).toMatch(/sdk: ['"]>=3\.0\.0 <4\.0\.0['"]/);
    expect(pubspec).toContain('flutter_lints: ^3.0.0');
    expect(pubspec).toMatch(/^flutter:$/m);
    expect(tree.read(`${ROOT}/analysis_options.yaml`, 'utf8')).toContain(
      'include: package:flutter_lints/flutter.yaml',
    );
    const ignore = tree.read(`${ROOT}/.gitignore`, 'utf8') ?? '';
    expect(ignore).toContain('.dart_tool/');
    expect(ignore).toContain('pubspec.lock');
    expect(tree.read(`${ROOT}/lib/shared_core.dart`, 'utf8')).toContain(
      "export 'src/shared_core.dart';",
    );
    expect(tree.read(`${ROOT}/lib/src/shared_core.dart`, 'utf8')).toContain('class SharedCore {');
    const test = tree.read(`${ROOT}/test/shared_core_test.dart`, 'utf8') ?? '';
    expect(test).toContain("import 'package:shared_core/shared_core.dart';");
  });

  it('writes project.json with analyze and test targets and no ts path', async () => {
    const cb = await libGenerator(tree, { name: 'shared-core', type: 'flutter' });
    const pj = readJson(tree, `${ROOT}/project.json`);
    expect(pj.name).toBe('flutter-shared-core');
    expect(pj.sourceRoot).toBe(`${ROOT}/lib`);
    expect(pj.tags).toEqual(['scope:flutter', 'type:flutter', 'platform:flutter']);
    expect(pj.targets).toEqual({
      analyze: { executor: 'nx:run-commands', options: { command: 'flutter analyze', cwd: ROOT } },
      test: { executor: 'nx:run-commands', options: { command: 'flutter test', cwd: ROOT } },
    });
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual({});
    expect(cb).toBeUndefined();
  });

  it('logs how to depend on the package from an app', async () => {
    await libGenerator(tree, { name: 'shared-core', type: 'flutter' });
    const logged = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(`shared_core:\n    path: ../../${ROOT}`);
  });

  it('rejects --variant', async () => {
    await expect(
      libGenerator(tree, { name: 'shared-core', type: 'flutter', variant: 'buildable' }),
    ).rejects.toThrow(/no variants/);
  });
});
