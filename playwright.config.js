import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive a real browser against the REAL multi-process cluster
 * (supervisor + 11 OS processes), on ports offset by +1000 with a throw-away data dir
 * so they never interfere with a dev instance on :8080.
 */
const OFFSET = 1000;
const BASE = `http://127.0.0.1:${8080 + OFFSET}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'reports/e2e', open: 'never' }]],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'node scripts/e2e-server.js',
    url: `http://127.0.0.1:${7000 + OFFSET}/ready`,
    timeout: 120000,
    reuseExistingServer: false,
    env: { PORT_OFFSET: String(OFFSET), DATA_DIR: '.e2e-data', LOG_LEVEL: 'warn', RAFT_ELECTION_MIN: '600', RAFT_ELECTION_MAX: '1200', RAFT_HEARTBEAT: '150' },
  },
});
