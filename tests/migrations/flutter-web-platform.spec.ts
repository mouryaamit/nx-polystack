import { addProjectConfiguration, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import flutterWebPlatform from '../../src/migrations/flutter-web-platform/flutter-web-platform';

const BUILD = '@mouryaamit/nx-polystack:flutter-build';

function flutterApp(tree: Tree, name: string, root: string, executor = BUILD): void {
  addProjectConfiguration(tree, name, {
    root,
    projectType: 'application',
    targets: {
      'build-web': { executor, options: { target: 'web', dist: `dist/${root}/web` } },
      'build-android': { executor, options: { target: 'apk' } },
    },
  });
  tree.write(`${root}/pubspec.yaml`, `name: ${name.replace(/-/g, '_')}\n`);
}

describe('flutter-web-platform migration (v1.0.0)', () => {
  it('adds web/index.html and web/manifest.json to plugin-built Flutter apps without them', async () => {
    const tree = createTreeWithEmptyWorkspace();
    flutterApp(tree, 'mobile', 'apps/mobile');
    await flutterWebPlatform(tree);
    const html = tree.read('apps/mobile/web/index.html')!.toString();
    expect(html).toContain('$FLUTTER_BASE_HREF');
    expect(html).toContain('flutter_bootstrap.js');
    expect(JSON.parse(tree.read('apps/mobile/web/manifest.json')!.toString()).name).toBe('Mobile');
  });

  it('keeps an existing web/ folder and files', async () => {
    const tree = createTreeWithEmptyWorkspace();
    flutterApp(tree, 'mobile', 'apps/mobile');
    tree.write('apps/mobile/web/index.html', '<!-- mine -->');
    await flutterWebPlatform(tree);
    expect(tree.read('apps/mobile/web/index.html')!.toString()).toBe('<!-- mine -->');
    expect(tree.exists('apps/mobile/web/manifest.json')).toBe(false);
  });

  it('leaves apps built another way and non-Flutter projects alone', async () => {
    const tree = createTreeWithEmptyWorkspace();
    flutterApp(tree, 'scripted', 'apps/scripted', 'nx:run-commands');
    addProjectConfiguration(tree, 'portal', {
      root: 'apps/portal',
      targets: { build: { executor: '@nx/angular:webpack-browser' } },
    });
    await flutterWebPlatform(tree);
    expect(tree.exists('apps/scripted/web/index.html')).toBe(false);
    expect(tree.exists('apps/portal/web/index.html')).toBe(false);
  });

  it('is idempotent', async () => {
    const tree = createTreeWithEmptyWorkspace();
    flutterApp(tree, 'mobile', 'apps/mobile');
    await flutterWebPlatform(tree);
    const first = tree.read('apps/mobile/web/index.html')!.toString();
    await flutterWebPlatform(tree);
    expect(tree.read('apps/mobile/web/index.html')!.toString()).toBe(first);
  });
});
