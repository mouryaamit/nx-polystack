import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import {
  CAPACITOR_CONFIGS,
  rewriteCapacitorConfig,
  rewriteWebDirText,
} from '../../../src/generators/migrate/ionic/capacitor-config';

describe('capacitor config webDir', () => {
  it('rewrites a single-quoted and a double-quoted top-level webDir', () => {
    expect(rewriteWebDirText(`const c = { appId: 'x', webDir: 'www' };`, 'd')).toEqual({
      text: `const c = { appId: 'x', webDir: 'd' };`,
      from: 'www',
    });
    expect(rewriteWebDirText(`export default { webDir: "www" }`, 'd')).toEqual({
      text: `export default { webDir: "d" }`,
      from: 'www',
    });
  });

  it('ignores comments, strings and nested objects', () => {
    const text = [
      '// webDir: "old"',
      'const config: CapacitorConfig = {',
      "  appId: 'x', /* webDir: 'nope' */",
      "  appName: 'webDir: here',",
      '  webDir: "www",',
      "  plugins: { Updater: { webDir: 'cache' } },",
      '};',
    ].join('\n');
    const out = rewriteWebDirText(text, '../../dist/apps/a');
    expect(out).toEqual({
      text: text.replace('webDir: "www"', 'webDir: "../../dist/apps/a"'),
      from: 'www',
    });
  });

  it('says when webDir is not set or not a plain string', () => {
    expect(rewriteWebDirText(`export default { appId: 'x' }`, 'd')).toEqual({ manual: 'not-set' });
    expect(
      rewriteWebDirText(
        `// webDir: 'www'\nexport default { plugins: { X: { webDir: 'a' } } }`,
        'd',
      ),
    ).toEqual({ manual: 'not-set' });
    expect(rewriteWebDirText(`export default { webDir: dir }`, 'd')).toEqual({
      manual: 'not-literal',
    });
    expect(rewriteWebDirText(`export default { webDir: 'a', webDir: 'b' }`, 'd')).toEqual({
      manual: 'not-literal',
    });
  });

  it('edits capacitor.config.json', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('apps/a/capacitor.config.json', JSON.stringify({ appId: 'x', webDir: 'www' }));
    expect(rewriteCapacitorConfig(tree, 'apps/a', '../../dist/apps/a')).toEqual({
      file: 'capacitor.config.json',
      from: 'www',
      to: '../../dist/apps/a',
    });
    expect(JSON.parse(tree.read('apps/a/capacitor.config.json', 'utf8')!).webDir).toBe(
      '../../dist/apps/a',
    );
  });

  it('edits capacitor.config.ts and reports a manual change when it cannot', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('apps/a/capacitor.config.ts', `export default { webDir: process.env.DIR };\n`);
    expect(rewriteCapacitorConfig(tree, 'apps/a', 'd')).toEqual({
      file: 'capacitor.config.ts',
      to: 'd',
      manual: 'not-literal',
    });
    expect(tree.read('apps/a/capacitor.config.ts', 'utf8')).toContain('process.env.DIR');
  });

  it('leaves an already-correct webDir alone and returns undefined without a config', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('apps/a/capacitor.config.js', `module.exports = { webDir: 'd' };\n`);
    expect(rewriteCapacitorConfig(tree, 'apps/a', 'd')).toEqual({
      file: 'capacitor.config.js',
      from: 'd',
      to: 'd',
    });
    expect(rewriteCapacitorConfig(tree, 'apps/b', 'd')).toBeUndefined();
    expect(CAPACITOR_CONFIGS).toEqual([
      'capacitor.config.ts',
      'capacitor.config.js',
      'capacitor.config.json',
    ]);
  });
});
