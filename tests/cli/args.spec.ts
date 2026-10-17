import { flagBoolean, flagString, parseArgs } from '../../src/cli/args';
import { CliError } from '../../src/cli/types';

describe('parseArgs', () => {
  it('splits command, positionals and flags', () => {
    const r = parseArgs(['new', 'my-ws', '--ci=jenkins', '--skip-install', '-d']);
    expect(r.command).toBe('new');
    expect(r.positionals).toEqual(['my-ws']);
    expect(r.flags).toEqual({ ci: 'jenkins', skipInstall: true, d: true });
  });

  it('keeps everything after the first "=" as the value', () => {
    expect(parseArgs(['app', '--cspConnectSrc=https://a.b/c?x=1']).flags['cspConnectSrc']).toBe(
      'https://a.b/c?x=1',
    );
  });

  it('returns an empty command when only flags are given', () => {
    expect(parseArgs(['--version']).command).toBe('');
  });
});

describe('flagString', () => {
  it('returns strings only', () => {
    expect(flagString({ a: 'x', b: true }, 'a')).toBe('x');
    expect(flagString({ a: 'x', b: true }, 'b')).toBeUndefined();
    expect(flagString({}, 'c')).toBeUndefined();
  });
});

describe('flagBoolean', () => {
  it('is true for a bare flag and true-ish values', () => {
    for (const v of [true, 'true', 'TRUE', '1', 'yes', 'on', '']) {
      expect(flagBoolean({ x: v }, 'x')).toBe(true);
    }
  });

  it('is false when missing or given a false-ish value', () => {
    expect(flagBoolean({}, 'x')).toBe(false);
    for (const v of [false, 'false', 'False', '0', 'no', 'off']) {
      expect(flagBoolean({ x: v }, 'x')).toBe(false);
    }
  });

  it('rejects anything else as a usage error', () => {
    expect(() => flagBoolean({ forceAngular: 'maybe' }, 'forceAngular')).toThrow(CliError);
    expect(() => flagBoolean({ forceAngular: 'maybe' }, 'forceAngular')).toThrow(
      '--force-angular must be true or false (got "maybe").',
    );
  });
});
