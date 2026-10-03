/**
 * Performance / load test (non-functional testing).
 * Boots a fresh in-process cluster (2 shards × 3 Raft replicas), then uses
 * autocannon to measure throughput and latency for the main access patterns,
 * including writes while the shard leader is killed mid-run.
 *
 *   npm run test:load          → prints a table and writes reports/load-test.md
 */
process.env.LOG_LEVEL ??= 'silent';
process.env.BCRYPT_ROUNDS ??= '4';

import autocannon from 'autocannon';
import fs from 'node:fs';
import { startStack, validPatient } from '../helpers/stack.js';
import { httpJson } from '../../src/common/http.js';

const DURATION = Number(process.env.LOAD_DURATION || 8);
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS || 20);

const run = (opts) =>
  new Promise((resolve, reject) => {
    const inst = autocannon({ duration: DURATION, connections: CONNECTIONS, ...opts }, (err, res) => (err ? reject(err) : resolve(res)));
    autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
  });

const row = (name, r, extra = '') => ({
  scenario: name,
  'req/s (avg)': Math.round(r.requests.average),
  'p50 ms': r.latency.p50,
  'p97.5 ms': r.latency.p97_5,
  'p99 ms': r.latency.p99,
  'max ms': r.latency.max,
  '2xx': r['2xx'],
  'non-2xx': r.non2xx,
  errors: r.errors + r.timeouts,
  notes: extra,
});

console.log(`Booting cluster… (${CONNECTIONS} connections × ${DURATION}s per scenario)`);
const stack = await startStack();
const token = await stack.login('dr.rohit', 'Doctor@123');
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const ids = [];
for (let i = 0; i < 12; i++) {
  const r = await httpJson(`${stack.url}/api/patients`, { method: 'POST', body: validPatient({ name: ['Adithya', 'Balaji', 'Charan', 'Dhruv', 'Eshwar', 'Gokul', 'Harsha', 'Jeevan', 'Kiran', 'Lokesh', 'Manoj', 'Naveen'][i] }), headers: auth });
  ids.push(r.data);
}
const hot = ids[0];
const results = [];

// 1. Hot read — served from the gateway cache after the first miss.
results.push(row('Read patient record (cache-aside, hot)', await run({ url: `${stack.url}/api/patients/${hot.id}`, headers: auth }), 'LRU cache hit'));

// 2. Directory — scatter-gather across both shards on every request (no cache).
results.push(row('Patient directory (scatter-gather, 2 shards)', await run({ url: `${stack.url}/api/patients`, headers: auth }), 'parallel fan-out'));

// 3. Writes — every request is a Raft round-trip to a majority, then cache invalidation.
let n = 0;
results.push(
  row(
    'Add clinical note (Raft commit)',
    await run({
      url: `${stack.url}/api/patients/${hot.id}/records`,
      method: 'POST',
      headers: auth,
      setupClient: (client) =>
        client.setBody(JSON.stringify({ type: 'note', title: 'Load test note', content: `note ${n++}` })),
    }),
    'majority replication',
  ),
);

// 4. Uncached linearizable reads spread over patients on both shards.
let k = 0;
results.push(
  row(
    'Read many patients (mixed hit/miss)',
    await run({
      url: `${stack.url}/api/patients/${hot.id}`,
      headers: auth,
      requests: [{ setupRequest: (req) => ({ ...req, path: `/api/patients/${ids[k++ % ids.length].id}` }) }],
    }),
    '12 patients, 2 shards',
  ),
);

// 5. Fail-over under load: kill the leader of the hot patient's shard 2 s into the run.
const victim = stack.leaderOf(hot.shardId);
setTimeout(() => stack.controlPlane.kill(victim.id), 2000);
const failover = await run({
  url: `${stack.url}/api/patients/${hot.id}/records`,
  method: 'POST',
  headers: auth,
  setupClient: (client) => client.setBody(JSON.stringify({ type: 'note', title: 'Failover note', content: 'written during election' })),
});
results.push(row(`Writes while leader ${victim.id} is killed`, failover, 'leader crash at t=2s'));
await stack.controlPlane.restart(victim.id);

console.table(results);

const cols = Object.keys(results[0]);
const md = [
  '# Load test report',
  '',
  `Generated ${new Date().toISOString()} · ${CONNECTIONS} concurrent connections · ${DURATION}s per scenario · Node ${process.version} on ${process.platform}`,
  '',
  'Cluster: API gateway + auth + event bus + audit + notify + 2 shards × 3 Raft replicas, all communicating over real HTTP on localhost.',
  '',
  `| ${cols.join(' | ')} |`,
  `| ${cols.map(() => '---').join(' | ')} |`,
  ...results.map((r) => `| ${cols.map((c) => r[c]).join(' | ')} |`),
  '',
  '**Reading the results**',
  '- Cached reads are served from the gateway without touching storage → highest throughput, lowest latency.',
  '- Writes are slower by design: each one waits for a majority of replicas to persist it (durability over speed).',
  '- In this harness ALL services and replicas share one Node.js event loop (single CPU core), so absolute numbers are a',
  '  lower bound; in production each service runs in its own process/container and scales horizontally.',
  '- During the fail-over run, requests stall for one election timeout and then resume on the new leader; ',
  '  `errors`/`non-2xx` show whether any client-visible failures occurred.',
  '',
].join('\n');
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/load-test.md', md);
console.log('Report written to reports/load-test.md');

await stack.stop();
process.exit(0);
