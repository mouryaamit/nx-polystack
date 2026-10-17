import {
  compareVersions,
  globalInstallCommand,
  formatPluginSpec,
  normalizeVersion,
  parsePluginSpec,
  PLUGIN_NAME,
} from '../../src/cli/versions';

describe('versions', () => {
  it('PLUGIN_NAME is the package name', () => {
    expect(PLUGIN_NAME).toBe('@mouryaamit/nx-polystack');
  });

  it('normalizeVersion strips a leading v', () => {
    expect(normalizeVersion('v0.3.0')).toBe('0.3.0');
    expect(normalizeVersion('0.3.0')).toBe('0.3.0');
  });

  it('normalizeVersion rejects non x.y.z input', () => {
    expect(() => normalizeVersion('latest')).toThrow(/not a valid version/);
    expect(() => normalizeVersion('1.2')).toThrow(/not a valid version/);
  });

  it('compareVersions orders numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.2.2', '0.3.0')).toBe(-1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });

  it('formatPluginSpec builds the git-tag spec', () => {
    expect(formatPluginSpec('0.3.0')).toBe('github:example-org/private-plugin#v0.3.0');
    expect(formatPluginSpec('v0.3.0')).toBe('github:example-org/private-plugin#v0.3.0');
  });

  it('parsePluginSpec returns the version for a tag spec', () => {
    expect(parsePluginSpec('github:example-org/private-plugin#v0.2.2')).toBe('0.2.2');
  });

  it('parsePluginSpec still recognises the earlier repo name (v0.38.2)', () => {
    expect(parsePluginSpec('github:mouryaamit/nx-polystack#v0.38.1')).toBe('0.38.1');
    expect(
      parsePluginSpec('git+ssh://git@github.com/example-org/private-plugin.git#v0.38.2'),
    ).toBe('0.38.2');
    expect(parsePluginSpec('github:mouryaamit/nx-polystack-other#v0.38.2')).toBeNull();
  });

  it.each([
    'git+https://github.com/mouryaamit/nx-polystack.git#v0.2.2',
    'git+https://github.com/mouryaamit/nx-polystack#v0.2.2',
    'git+ssh://git@github.com/mouryaamit/nx-polystack.git#v0.2.2',
    'git+ssh://git@github.com/mouryaamit/nx-polystack#v0.2.2',
    'github:mouryaamit/nx-polystack#v0.2.2',
    'github:mouryaamit/nx-polystack.git#v0.2.2',
    'mouryaamit/nx-polystack#v0.2.2',
    'mouryaamit/nx-polystack.git#v0.2.2',
  ])('parsePluginSpec accepts %s', (spec) => {
    expect(parsePluginSpec(spec)).toBe('0.2.2');
  });

  it('parsePluginSpec returns null for a different repo', () => {
    expect(parsePluginSpec('github:other/nx-polystack#v0.2.2')).toBeNull();
    expect(parsePluginSpec('git+https://github.com/other/nx-polystack.git#v0.2.2')).toBeNull();
    expect(parsePluginSpec('mouryaamit/other#v0.2.2')).toBeNull();
    expect(
      parsePluginSpec('git+https://example.com/mouryaamit/nx-polystack.git#v0.2.2'),
    ).toBeNull();
  });

  it('parsePluginSpec returns null for anything else', () => {
    expect(parsePluginSpec('github:mouryaamit/nx-polystack')).toBeNull();
    expect(parsePluginSpec('file:../nx-polystack')).toBeNull();
    expect(parsePluginSpec('latest')).toBeNull();
    expect(parsePluginSpec('>=0.2.2')).toBeNull();
    expect(parsePluginSpec('github:mouryaamit/nx-polystack#master')).toBeNull();
  });

  it('globalInstallCommand downloads the private release asset with gh, then installs it', () => {
    expect(globalInstallCommand('v0.3.2')).toBe(
      'gh release download v0.3.2 -R example-org/private-plugin -p mouryaamit-nx-polystack-v0.3.2.tgz -D /tmp --clobber' +
        ' && npm i -g /tmp/mouryaamit-nx-polystack-v0.3.2.tgz',
    );
  });
});
