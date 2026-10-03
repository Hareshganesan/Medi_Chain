import fs from 'node:fs';
import { config } from '../cluster.config.js';

fs.rmSync(config.dataDir, { recursive: true, force: true });
console.log(`Removed ${config.dataDir}/ — the next \`npm start\` boots a fresh cluster and re-seeds demo data.`);
