// Fresh cluster for every E2E run: wipe the throw-away data dir, then boot the supervisor.
import fs from 'node:fs';

fs.rmSync(process.env.DATA_DIR || '.e2e-data', { recursive: true, force: true });
await import('../src/supervisor/index.js');
