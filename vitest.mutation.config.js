import { defineConfig } from 'vitest/config';

// Mutation testing runs the fast, deterministic unit tests of the pure core modules.
export default defineConfig({
  test: {
    include: [
      'tests/unit/consistent-hash.test.js',
      'tests/unit/circuit-breaker.test.js',
      'tests/unit/rate-limiter-cache.test.js',
      'tests/unit/crypto-hashchain.test.js',
      'tests/unit/rbac.test.js',
      'tests/unit/infrastructure.test.js',
      'tests/unit/mutation-hardening.test.js',
    ],
    env: { LOG_LEVEL: 'silent' },
  },
});
