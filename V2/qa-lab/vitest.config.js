import { defineConfig } from 'vitest/config';

// Self-tests for the QA Lab tooling (`npm run test:lab`). Kept apart from the product suite,
// because the lab is test infrastructure, not part of the system under test.
export default defineConfig({
  test: {
    root: '.',
    include: ['qa-lab/tests/**/*.test.js'],
    testTimeout: 120000,
    fileParallelism: false,
  },
});
