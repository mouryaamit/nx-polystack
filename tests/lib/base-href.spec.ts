import { isDevConfiguration } from '../../src/lib/utils/base-href';

describe('isDevConfiguration', () => {
  it('reads the configuration env, then the target env, then the executor default, then the name', () => {
    const angular = {
      executor: '@mouryaamit/nx-polystack:build',
      configurations: { dev: { env: 'DEV' }, uat: { env: 'UAT' }, development: {}, qa: {} },
    };
    expect(['dev', 'uat', 'development', 'qa'].map((c) => isDevConfiguration(angular, c))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    const flutter = {
      executor: '@mouryaamit/nx-polystack:flutter-build',
      configurations: { staging: {}, uat: { env: 'uat' } },
    };
    expect(isDevConfiguration(flutter, 'staging')).toBe(true);
    expect(isDevConfiguration(flutter, 'uat')).toBe(false);
    const withOptions = { options: { env: 'UAT' }, configurations: { dev: {} } };
    expect(isDevConfiguration(withOptions, 'dev')).toBe(false);
  });
});
