import { DEV_GITHUB_REPO, setInstallSourceForTests } from '../../src/cli/install-source';
import { findPluginPin, resolveTarget } from '../../src/cli/update-plan';

const SPEC = (v: string) => `github:example-org/private-plugin#v${v}`;

describe('findPluginPin', () => {
  it('reads devDependencies first', () => {
    expect(
      findPluginPin({ devDependencies: { '@mouryaamit/nx-polystack': SPEC('0.2.2') } }),
    ).toEqual({
      field: 'devDependencies',
      version: '0.2.2',
      spec: SPEC('0.2.2'),
      range: false,
    });
  });

  it('falls back to dependencies', () => {
    expect(findPluginPin({ dependencies: { '@mouryaamit/nx-polystack': SPEC('0.2.0') } })).toEqual({
      field: 'dependencies',
      version: '0.2.0',
      spec: SPEC('0.2.0'),
      range: false,
    });
  });

  it('reads npm pins, marking ranges', () => {
    expect(findPluginPin({ devDependencies: { '@mouryaamit/nx-polystack': '^1.2.0' } })).toEqual({
      field: 'devDependencies',
      version: '1.2.0',
      spec: '^1.2.0',
      range: true,
    });
    expect(findPluginPin({ devDependencies: { '@mouryaamit/nx-polystack': '1.2.0' } }).range).toBe(
      false,
    );
  });

  it('throws when missing', () => {
    expect(() => findPluginPin({})).toThrow(/not listed/);
  });

  it('throws when not a tag spec', () => {
    expect(() =>
      findPluginPin({ devDependencies: { '@mouryaamit/nx-polystack': 'file:../nx-polystack' } }),
    ).toThrow(/pinned version/);
  });
});

describe('findPluginPin hints (NX-51)', () => {
  afterEach(() => setInstallSourceForTests({ kind: 'github', repo: DEV_GITHUB_REPO }));

  it('an npm build suggests an npm install of a real version', () => {
    setInstallSourceForTests({ kind: 'npm' });
    expect(() => findPluginPin({}, '1.2.0')).toThrow(
      'Add it first: npm i -D @mouryaamit/nx-polystack@1.2.0 --save-exact',
    );
    expect(() =>
      findPluginPin({ devDependencies: { '@mouryaamit/nx-polystack': 'latest' } }, '1.2.0'),
    ).toThrow('pin one first: npm i -D @mouryaamit/nx-polystack@1.2.0 --save-exact');
  });
});

describe('resolveTarget', () => {
  it('defaults to the CLI version', () => {
    expect(resolveTarget('0.2.2', undefined, '0.3.0', false)).toEqual({
      action: 'upgrade',
      to: '0.3.0',
    });
  });

  it('accepts --to with a leading v', () => {
    expect(resolveTarget('0.2.2', 'v0.4.0', '0.3.0', false)).toEqual({
      action: 'upgrade',
      to: '0.4.0',
    });
  });

  it('is a noop when equal', () => {
    expect(resolveTarget('0.3.0', undefined, '0.3.0', false)).toEqual({
      action: 'noop',
      to: '0.3.0',
    });
  });

  it('refuses a downgrade without force', () => {
    expect(() => resolveTarget('0.3.0', '0.2.2', '0.3.0', false)).toThrow(/--force/);
    expect(resolveTarget('0.3.0', '0.2.2', '0.3.0', true)).toEqual({
      action: 'downgrade',
      to: '0.2.2',
    });
  });

  it('explains an outdated global CLI when no --to was given', () => {
    expect(() => resolveTarget('0.3.0', undefined, '0.2.2', false)).toThrow(
      /global CLI v0\.2\.2.*gh release download v0\.3\.0 -R \S+ .*npm i -g.*--force/s,
    );
  });

  it('keeps the plain --force wording for an explicit --to', () => {
    expect(() => resolveTarget('0.3.0', '0.2.2', '0.4.0', false)).toThrow(
      /v0\.2\.2 is older than the installed v0\.3\.0\. Pass --force/,
    );
  });
});
