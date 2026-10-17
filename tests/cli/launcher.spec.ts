import { resolveLocalPlugin } from '../../src/cli/context';
import {
  assertLocalSupports,
  MIN_LOCAL_VERSION,
  shouldDelegate,
  upgradeHint,
} from '../../src/cli/launcher';
import { CliError } from '../../src/cli/types';

import { fakeLocalPlugin, REPO_ROOT, tmpDir } from './helpers';

function setup(version = '0.2.2') {
  const ws = tmpDir();
  fakeLocalPlugin(ws, version);
  return resolveLocalPlugin(ws);
}

describe('shouldDelegate', () => {
  const base = { flags: {}, env: {}, selfRoot: REPO_ROOT };

  it('delegates app/lib/env/preset/migrate to a different local install', () => {
    const local = setup();
    for (const command of ['app', 'lib', 'env', 'preset', 'migrate']) {
      expect(shouldDelegate({ ...base, command, local })).toBe(true);
    }
  });

  it('never delegates help, new, update, _migrate or an empty command', () => {
    const local = setup();
    for (const command of ['help', 'new', 'update', '_migrate', '']) {
      expect(shouldDelegate({ ...base, command, local })).toBe(false);
    }
  });

  it('does not delegate --help or --version', () => {
    const local = setup();
    for (const flags of [{ help: true }, { h: true }, { version: true }, { v: true }]) {
      expect(shouldDelegate({ ...base, flags, command: 'app', local })).toBe(false);
    }
  });

  it('does not delegate without a local plugin', () => {
    expect(shouldDelegate({ ...base, command: 'app', local: null })).toBe(false);
  });

  it('does not delegate when already delegated', () => {
    const local = setup();
    expect(shouldDelegate({ ...base, env: { PSTACK_DELEGATED: '1' }, command: 'app', local })).toBe(
      false,
    );
  });

  it('only treats PSTACK_DELEGATED=1 as already delegated', () => {
    const local = setup();
    expect(shouldDelegate({ ...base, env: { PSTACK_DELEGATED: '0' }, command: 'app', local })).toBe(
      true,
    );
  });

  it('does not delegate to itself', () => {
    const local = setup();
    if (!local) throw new Error('setup failed');
    expect(shouldDelegate({ ...base, selfRoot: local.root, command: 'app', local })).toBe(false);
  });
});

describe('upgradeHint', () => {
  it('suggests update when the workspace is older', () => {
    expect(upgradeHint('0.2.2', '0.3.0')).toMatch(/v0\.2\.2.*v0\.3\.0.*pstack update/);
  });

  it('is null when a version cannot be parsed', () => {
    expect(upgradeHint('0.2.2', '0.3.0-rc.1')).toBeNull();
    expect(upgradeHint('0.3.0-rc.1', '0.3.0')).toBeNull();
    expect(upgradeHint(undefined as unknown as string, '0.3.0')).toBeNull();
  });

  it('is null when equal or newer', () => {
    expect(upgradeHint('0.3.0', '0.3.0')).toBeNull();
    expect(upgradeHint('0.4.0', '0.3.0')).toBeNull();
  });
});

describe('assertLocalSupports', () => {
  it('requires nx-polystack 0.6.0 for lib', () => {
    expect(MIN_LOCAL_VERSION['lib']).toBe('0.6.0');
  });

  it('fails clearly when the pinned plugin predates the command', () => {
    expect(() => assertLocalSupports('lib', '0.5.0')).toThrow(CliError);
    expect(() => assertLocalSupports('lib', '0.5.0')).toThrow(
      'pstack lib needs nx-polystack >= 0.6.0 in this workspace (found 0.5.0). ' +
        'Run "pstack update" first.',
    );
  });

  it('passes for new enough plugins, other commands and unreadable versions', () => {
    expect(() => assertLocalSupports('lib', '0.6.0')).not.toThrow();
    expect(() => assertLocalSupports('lib', 'v0.7.1')).not.toThrow();
    expect(() => assertLocalSupports('app', '0.1.0')).not.toThrow();
    expect(() => assertLocalSupports('lib', 'main')).not.toThrow();
  });
});
