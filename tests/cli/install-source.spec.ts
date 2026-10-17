import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEV_GITHUB_REPO,
  installSource,
  parseInstallSource,
  readInstallSource,
  setInstallSourceForTests,
} from '../../src/cli/install-source';
import {
  formatPluginSpec,
  globalInstallCommand,
  parsePluginSpec,
  pinInstallFlags,
} from '../../src/cli/versions';

const DEV = { kind: 'github', repo: DEV_GITHUB_REPO } as const;

describe('install source (NX-51)', () => {
  afterEach(() => setInstallSourceForTests(DEV));

  it('parses the package.json setting', () => {
    expect(parseInstallSource(undefined)).toEqual({
      kind: 'github',
      repo: 'example-org/private-plugin',
    });
    expect(parseInstallSource('npm')).toEqual({ kind: 'npm' });
    expect(parseInstallSource('github:acme/tool')).toEqual({ kind: 'github', repo: 'acme/tool' });
    expect(() => parseInstallSource('gitlab:acme/tool')).toThrow(/installSource/);
    expect(() => parseInstallSource(5)).toThrow(/installSource/);
  });

  it('reads the plugin package.json above a folder, ignoring other packages', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-src-'));
    const inner = path.join(root, 'node_modules', 'other');
    fs.mkdirSync(path.join(inner, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@mouryaamit/nx-polystack', pstack: { installSource: 'npm' } }),
    );
    fs.writeFileSync(path.join(inner, 'package.json'), JSON.stringify({ name: 'other' }));
    expect(readInstallSource(path.join(inner, 'lib'))).toEqual({ kind: 'npm' });
    expect(readInstallSource(os.tmpdir())).toEqual({
      kind: 'github',
      repo: 'example-org/private-plugin',
    });
  });

  it("reads this package's own setting, and tests run as the development build", () => {
    expect(() => readInstallSource()).not.toThrow();
    expect(installSource()).toEqual(DEV);
  });

  it('an npm build pins exact npm versions and installs the CLI from npm', () => {
    setInstallSourceForTests({ kind: 'npm' });
    expect(formatPluginSpec('v1.2.0')).toBe('1.2.0');
    expect(pinInstallFlags()).toEqual(['--save-exact']);
    expect(globalInstallCommand('1.2.0')).toBe('npm i -g @mouryaamit/nx-polystack@1.2.0');
    // Git pins of a dev workspace are still read, so pstack update can move them to npm.
    expect(parsePluginSpec('github:example-org/private-plugin#v0.38.2')).toBe('0.38.2');
  });

  it('a GitHub build pins tags of its repo and recognises npm pins', () => {
    setInstallSourceForTests({ kind: 'github', repo: 'acme/tool' });
    expect(formatPluginSpec('1.2.0')).toBe('github:acme/tool#v1.2.0');
    expect(pinInstallFlags()).toEqual([]);
    expect(globalInstallCommand('1.2.0')).toContain('-R acme/tool ');
    expect(parsePluginSpec('github:acme/tool#v1.2.0')).toBe('1.2.0');
    expect(parsePluginSpec('github:example-org/private-plugin#v1.2.0')).toBe('1.2.0');
    for (const s of ['1.2.0', '^1.2.0', '~1.2.0', '=1.2.0', ' 1.2.0 ']) {
      expect(parsePluginSpec(s)).toBe('1.2.0');
    }
  });
});
