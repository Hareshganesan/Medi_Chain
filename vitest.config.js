import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/{unit,integration,chaos}/**/*.test.js'],
    env: { LOG_LEVEL: 'silent', BCRYPT_ROUNDS: '4' },
    testTimeout: 20000,
    hookTimeout: 30000,
    // Integration suites bind real ports — run files one at a time.
    fileParallelism: false,
    reporters: ['default', ['junit', { outputFile: 'reports/junit.xml' }], ['html', { outputFile: 'reports/test-report/index.html' }]],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/**/main.js', 'src/supervisor/**'],
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'reports/coverage',
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
