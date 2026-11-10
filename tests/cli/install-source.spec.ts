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
  templateFromPin,
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

  it('parses a git URL template whose #ref holds {version} (v1.23.0)', () => {
    const t = 'git+https://git.example.com/acme/tool.git#dist-v{version}';
    expect(parseInstallSource(t)).toEqual({ kind: 'git', template: t });
    expect(parseInstallSource('git+ssh://git@git.example.com/acme/tool.git#v{version}')).toEqual({
      kind: 'git',
      template: 'git+ssh://git@git.example.com/acme/tool.git#v{version}',
    });
    for (const bad of [
      'git+https://git.example.com/acme/tool.git#dist-v1.2.0', // no {version}
      'git+https://git.example.com/{version}/tool.git#dist', // {version} not in the ref
      'git+https://git.example.com/acme/tool.git#{version}-{version}', // twice
      'https://git.example.com/acme/tool.git#dist-v{version}', // not git+
      'git+https://git.example.com/acme/tool.git #dist-v{version}', // space
    ]) {
      expect(() => parseInstallSource(bad)).toThrow(/installSource must be/);
    }
  });

  it('a git build pins its URL with the version and installs the CLI from it (v1.23.0)', () => {
    const t = 'git+https://git.example.com/acme/tool.git#dist-v{version}';
    setInstallSourceForTests({ kind: 'git', template: t });
    expect(formatPluginSpec('v1.23.0')).toBe(
      'git+https://git.example.com/acme/tool.git#dist-v1.23.0',
    );
    expect(pinInstallFlags()).toEqual([]);
    expect(globalInstallCommand('1.23.0')).toBe(
      'npm i -g "@mouryaamit/nx-polystack@git+https://git.example.com/acme/tool.git#dist-v1.23.0"',
    );
    expect(parsePluginSpec('git+https://git.example.com/acme/tool.git#dist-v1.23.0')).toBe(
      '1.23.0',
    );
    expect(parsePluginSpec('git+https://git.example.com/acme/tool.git#dist-v1.23')).toBeNull();
    expect(parsePluginSpec('git+https://git.example.com/acme/other.git#dist-v1.23.0')).toBeNull();
    // Earlier pins are still read, so pstack update can move them to the git source.
    expect(parsePluginSpec('1.22.0')).toBe('1.22.0');
    expect(parsePluginSpec('github:example-org/private-plugin#v1.22.0')).toBe('1.22.0');
    // Another package name for the CLI install (a renamed copy).
    expect(globalInstallCommand('1.23.0', { kind: 'git', template: t }, '@acme/tool')).toBe(
      'npm i -g "@acme/tool@git+https://git.example.com/acme/tool.git#dist-v1.23.0"',
    );
  });

  it('reads a git install source off a workspace pin (v1.23.0)', () => {
    expect(templateFromPin('git+https://git.example.com/a/b.git#dist-v1.22.0', '1.22.0')).toEqual({
      kind: 'git',
      template: 'git+https://git.example.com/a/b.git#dist-v{version}',
    });
    // The version only in the ref, once; not for other specs.
    expect(templateFromPin('git+https://h/1.22.0/b.git#dist-v1.22.0', '1.22.0')).toEqual({
      kind: 'git',
      template: 'git+https://h/1.22.0/b.git#dist-v{version}',
    });
    for (const [spec, v] of [
      ['git+https://h/a/b.git#dist-v1.21.0', '1.22.0'],
      ['git+https://h/a/b.git#1.22.0-1.22.0', '1.22.0'],
      ['1.22.0', '1.22.0'],
      ['github:a/b#v1.22.0', '1.22.0'],
      ['git+https://h/a/b.git#dist-v1.22.0', 'latest'],
    ]) {
      expect(templateFromPin(spec, v)).toBeNull();
    }
  });
});
