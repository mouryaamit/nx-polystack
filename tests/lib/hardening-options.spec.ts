import {
  DEFAULT_DROP_CONSOLE,
  OBFUSCATE_MODES,
  resolveHardening,
} from '../../src/lib/hardening/options';

const OFF = {
  leakCheck: 'off',
  sourceMaps: 'off',
  stripComments: false,
  dropConsole: [],
  obfuscate: 'off',
  obfuscateOptions: {},
};

describe('resolveHardening', () => {
  it('turns everything off for DEV, without warnings', () => {
    const r = resolveHardening(
      {
        leakCheck: 'fail',
        sourceMaps: 'fail',
        stripComments: true,
        dropConsole: ['log'],
        harden: true,
        obfuscate: 'light',
      },
      'DEV',
      { LEAK_CHECK: 'fail' },
    );
    expect(r).toEqual({ ...OFF, warnings: [] });
  });

  it('treats absent options as off', () => {
    expect(resolveHardening({}, 'UAT', {})).toEqual({ ...OFF, warnings: [] });
  });

  it('passes set options through', () => {
    const r = resolveHardening(
      { leakCheck: 'fail', sourceMaps: 'warn', stripComments: true, dropConsole: ['log', 'warn'] },
      'PROD',
      {},
    );
    expect(r).toEqual({
      leakCheck: 'fail',
      sourceMaps: 'warn',
      stripComments: true,
      dropConsole: ['log', 'warn'],
      obfuscate: 'off',
      obfuscateOptions: {},
      warnings: [],
    });
  });

  it('maps harden: true to stripComments and the default dropConsole, with a warning', () => {
    const r = resolveHardening({ harden: true }, 'UAT', {});
    expect(r.stripComments).toBe(true);
    expect(r.dropConsole).toEqual(DEFAULT_DROP_CONSOLE);
    expect(r.leakCheck).toBe('off');
    expect(r.warnings).toEqual([
      'harden is replaced by stripComments and dropConsole (and leakCheck, sourceMaps); set those instead',
    ]);
  });

  it('keeps explicit stripComments and dropConsole over harden', () => {
    const r = resolveHardening(
      { harden: true, stripComments: false, dropConsole: ['error'] },
      'UAT',
      {},
    );
    expect(r.stripComments).toBe(false);
    expect(r.dropConsole).toEqual(['error']);
    expect(r.warnings).toHaveLength(1);
  });

  it('lets LEAK_CHECK override leakCheck, case-insensitively', () => {
    expect(resolveHardening({ leakCheck: 'fail' }, 'UAT', { LEAK_CHECK: 'Warn' }).leakCheck).toBe(
      'warn',
    );
    expect(resolveHardening({}, 'PROD', { LEAK_CHECK: 'FAIL' }).leakCheck).toBe('fail');
    expect(resolveHardening({ leakCheck: 'fail' }, 'UAT', { LEAK_CHECK: '' }).leakCheck).toBe(
      'fail',
    );
  });

  it('rejects an invalid LEAK_CHECK value, naming the variable', () => {
    expect(() => resolveHardening({}, 'UAT', { LEAK_CHECK: 'maybe' })).toThrow(/LEAK_CHECK/);
  });

  it('rejects invalid modes and console methods, naming the option', () => {
    expect(() => resolveHardening({ leakCheck: 'loud' as never }, 'UAT', {})).toThrow(/leakCheck/);
    expect(() => resolveHardening({ sourceMaps: 'yes' as never }, 'UAT', {})).toThrow(/sourceMaps/);
    expect(() => resolveHardening({ dropConsole: ['log', 'table'] }, 'UAT', {})).toThrow(
      /dropConsole.*table/,
    );
  });

  it('removes duplicates from dropConsole', () => {
    expect(
      resolveHardening({ dropConsole: ['log', 'warn', 'log'] }, 'UAT', {}).dropConsole,
    ).toEqual(['log', 'warn']);
  });

  it('rejects a dropConsole that is not a list, naming the option', () => {
    expect(() => resolveHardening({ dropConsole: 'log' as never }, 'UAT', {})).toThrow(
      /dropConsole must be a list/,
    );
  });

  it('exports the obfuscate modes', () => {
    expect(OBFUSCATE_MODES).toEqual(['off', 'light', 'medium', 'strong']);
  });

  it('passes obfuscate through for non-DEV envs', () => {
    expect(resolveHardening({ obfuscate: 'light' }, 'UAT', {}).obfuscate).toBe('light');
    expect(resolveHardening({ obfuscate: 'off' }, 'PROD', {}).obfuscate).toBe('off');
    expect(resolveHardening({ obfuscate: 'light' }, 'QA', {}).obfuscate).toBe('light');
  });

  it('turns obfuscate off for DEV and when absent', () => {
    expect(resolveHardening({ obfuscate: 'light' }, 'DEV', {}).obfuscate).toBe('off');
    expect(resolveHardening({}, 'PROD', {}).obfuscate).toBe('off');
  });

  it('rejects an unknown obfuscate value, naming the option and value', () => {
    expect(() => resolveHardening({ obfuscate: 'heavy' as never }, 'UAT', {})).toThrow(
      'obfuscate must be one of off, light, medium, strong (got "heavy")',
    );
  });

  it('accepts the obfuscation levels and checks obfuscateOptions', () => {
    for (const level of ['light', 'medium', 'strong'] as const) {
      expect(resolveHardening({ obfuscate: level }, 'UAT').obfuscate).toBe(level);
    }
    expect(
      resolveHardening({ obfuscateOptions: { stringArrayThreshold: 0.3 } }, 'UAT').obfuscateOptions,
    ).toEqual({ stringArrayThreshold: 0.3 });
    expect(
      resolveHardening({ obfuscateOptions: { stringArrayThreshold: 0.3 } }, 'DEV').obfuscateOptions,
    ).toEqual({});
    expect(() => resolveHardening({ obfuscateOptions: { selfDefending: true } }, 'UAT')).toThrow(
      /obfuscateOptions.selfDefending cannot be set \(allowed: stringArray, /,
    );
    expect(() =>
      resolveHardening({ obfuscateOptions: { stringArrayThreshold: 2 } }, 'UAT'),
    ).toThrow('obfuscateOptions.stringArrayThreshold must be a number from 0 to 1');
    expect(() =>
      resolveHardening({ obfuscateOptions: { stringArrayEncoding: ['xor'] } }, 'UAT'),
    ).toThrow('obfuscateOptions.stringArrayEncoding must be a list of none, base64, rc4');
    expect(() => resolveHardening({ obfuscateOptions: [] as never }, 'UAT')).toThrow(
      'obfuscateOptions must be an object',
    );
  });
});
