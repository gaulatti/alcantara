module.exports = {
  rootDir: '..',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.e2e-spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': '<rootDir>/scripts/jest-source-coverage-transformer.cjs',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s', '!src/**/*.d.ts'],
  coverageProvider: 'babel',
  coverageDirectory: 'coverage',
  coverageReporters: ['json', 'json-summary', 'text'],
  coverageThreshold: { global: { lines: 100, branches: 100 } },
};
