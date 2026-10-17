/* eslint-disable */
export default {
  displayName: 'nx-polystack',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  setupFiles: ['<rootDir>/tests/setup/install-source.ts'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  // tests/fixtures holds sample source repos (e.g. an Angular app with its own *.spec.ts): data, not tests.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/fixtures/'],
  modulePathIgnorePatterns: ['<rootDir>/dist', '<rootDir>/tests/fixtures/'],
  coverageDirectory: 'coverage',
};
