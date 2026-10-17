import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import appGenerator from '../../src/generators/app/generator';

describe('app generator --type=flutter', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: {} }));
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it('creates pubspec.yaml under apps/<name>/', async () => {
    await appGenerator(tree, { name: 'consumer-app', type: 'flutter' });
    expect(tree.exists('apps/consumer-app/pubspec.yaml')).toBe(true);
  });

  it('creates lib/main.dart', async () => {
    await appGenerator(tree, { name: 'consumer-app', type: 'flutter' });
    expect(tree.exists('apps/consumer-app/lib/main.dart')).toBe(true);
  });

  it('creates the web platform folder flutter build web needs', async () => {
    await appGenerator(tree, { name: 'consumer-app', type: 'flutter' });
    const html = tree.read('apps/consumer-app/web/index.html')!.toString();
    expect(html).toMatch(/<base href="\$FLUTTER_BASE_HREF"\s*\/?>/);
    expect(html).toMatch(/<script src="flutter_bootstrap.js" async><\/script>/);
    expect(html).toContain('<title>Consumer App</title>');
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    const manifest = JSON.parse(tree.read('apps/consumer-app/web/manifest.json')!.toString());
    expect(manifest.name).toBe('Consumer App');
  });

  it('creates env/{dev,uat,prod}.json', async () => {
    await appGenerator(tree, { name: 'consumer-app', type: 'flutter' });
    expect(tree.exists('apps/consumer-app/env/dev.json')).toBe(true);
    expect(tree.exists('apps/consumer-app/env/uat.json')).toBe(true);
    expect(tree.exists('apps/consumer-app/env/prod.json')).toBe(true);
  });

  it('generates project.json with all 5 targets', async () => {
    await appGenerator(tree, { name: 'consumer-app', type: 'flutter' });
    const pj = JSON.parse(tree.read('apps/consumer-app/project.json')!.toString());
    expect(pj.targets).toHaveProperty('serve');
    expect(pj.targets).toHaveProperty('build-web');
    expect(pj.targets).toHaveProperty('build-android');
    expect(pj.targets).toHaveProperty('build-ios');
    expect(pj.targets).toHaveProperty('export');
  });

  it('project.json targets reference the plugin executor', async () => {
    await appGenerator(tree, { name: 'consumer-app', type: 'flutter' });
    const pj = JSON.parse(tree.read('apps/consumer-app/project.json')!.toString());
    expect(pj.targets['build-web'].executor).toBe('@mouryaamit/nx-polystack:flutter-build');
    expect(pj.targets['export'].executor).toBe('@mouryaamit/nx-polystack:flutter-export');
  });

  it('adds npm scripts to root package.json', async () => {
    await appGenerator(tree, { name: 'consumer-app', type: 'flutter' });
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.scripts).toHaveProperty('serve:consumer-app');
    expect(pkg.scripts).toHaveProperty('build:consumer-app:prod:web');
    expect(pkg.scripts).toHaveProperty('build:consumer-app:prod:apk');
  });

  it('scaffolds L10n ARB files when --i18n is provided', async () => {
    await appGenerator(tree, { name: 'myapp', type: 'flutter', i18n: ['en', 'hi'] });
    expect(tree.exists('apps/myapp/lib/l10n/app_en.arb')).toBe(true);
    expect(tree.exists('apps/myapp/lib/l10n/app_hi.arb')).toBe(true);
    expect(tree.exists('apps/myapp/l10n.yaml')).toBe(true);
  });

  it('throws when type is unsupported', async () => {
    await expect(appGenerator(tree, { name: 'test', type: 'react' as never })).rejects.toThrow(
      /not supported/i,
    );
  });

  it('generates server/nginx.conf', async () => {
    await appGenerator(tree, { name: 'consumer-app', type: 'flutter' });
    expect(tree.exists('apps/consumer-app/server/nginx.conf')).toBe(true);
    const content = tree.read('apps/consumer-app/server/nginx.conf')!.toString();
    expect(content).toContain('wasm-unsafe-eval');
    expect(content).toContain('worker-src blob:');
  });

  it('scaffolds notifications.dart when --push=fcm', async () => {
    await appGenerator(tree, { name: 'push-app', type: 'flutter', push: 'fcm' });
    expect(tree.exists('apps/push-app/lib/notifications.dart')).toBe(true);
  });

  it('scaffolds assetlinks.json when --deeplink is provided', async () => {
    await appGenerator(tree, {
      name: 'link-app',
      type: 'flutter',
      deeplink: 'https://example.com',
    });
    expect(tree.exists('libs/well-known/dev/.well-known/assetlinks.json')).toBe(true);
  });
});
