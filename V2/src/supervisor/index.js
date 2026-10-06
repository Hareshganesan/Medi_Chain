/**
 * Supervisor — launches the whole distributed system with one command (`npm start`)
 * and acts as the control plane (think: a tiny Kubernetes) so the Ops Console
 * can kill and restart real replica processes for fault-injection demos.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, urlOf } from '../../cluster.config.js';
import { requireServiceToken } from '../common/security.js';
import { httpJson, sleep } from '../common/http.js';
import { seed } from './seed.js';

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../main.js');
const COLORS = [36, 35, 33, 32, 34, 91, 92, 93, 94, 95, 96];
const procs = new Map(); // name → { child, args, color, restarts, startedAt }

const services = [
  { name: 'auth', args: ['auth'] },
  { name: 'eventbus', args: ['eventbus'] },
  ...config.shards.flatMap((sh) => sh.nodes.map((n) => ({ name: n.id, args: ['node', n.id] }))),
  { name: 'audit', args: ['audit'] },
  { name: 'notify', args: ['notify'] },
  { name: 'gateway', args: ['gateway'] },
];

function launch(name, args, color) {
  const child = fork(MAIN, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env } });
  const prefix = `\x1b[${color}m${name.padEnd(8)}\x1b[0m│ `;
  const pipe = (stream) =>
    stream.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) if (line.trim()) process.stdout.write(prefix + line + '\n');
    });
  pipe(child.stdout);
  pipe(child.stderr);
  const entry = procs.get(name) ?? { args, color, restarts: 0 };
  Object.assign(entry, { child, startedAt: Date.now(), alive: true });
  child.on('exit', (code, signal) => {
    entry.alive = false;
    if (!shuttingDown) console.log(`${prefix}\x1b[31mprocess exited (${signal ?? code})\x1b[0m`);
  });
  procs.set(name, entry);
  return entry;
}

// ─── control plane API (internal only) ───
let ready = false;
const app = express();
app.use(express.json());
app.get('/ready', (req, res) => res.status(ready ? 200 : 503).json({ ready })); // cluster up + seeded
app.use(requireServiceToken(config.internalToken));
app.get('/processes', (req, res) => {
  res.json({ processes: [...procs.entries()].map(([name, p]) => ({ name, alive: p.alive, pid: p.child.pid, restarts: p.restarts, startedAt: p.startedAt })) });
});
app.post('/processes/:name/kill', (req, res) => {
  const p = procs.get(req.params.name);
  if (!p) return res.status(404).json({ error: 'NO_SUCH_PROCESS' });
  if (!p.alive) return res.status(409).json({ error: 'ALREADY_STOPPED' });
  p.child.kill('SIGKILL'); // hard crash — no graceful shutdown, like pulling the power cable
  res.json({ killed: req.params.name });
});
app.post('/processes/:name/restart', (req, res) => {
  const p = procs.get(req.params.name);
  if (!p) return res.status(404).json({ error: 'NO_SUCH_PROCESS' });
  if (p.alive) p.child.kill('SIGKILL');
  p.restarts++;
  launch(req.params.name, p.args, p.color);
  res.json({ restarted: req.params.name });
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping all services…');
  for (const p of procs.values()) if (p.alive) p.child.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  console.log('\n\x1b[1m\x1b[36m  MediChain — Distributed Healthcare Records System\x1b[0m');
  console.log(`  ${config.shards.length} shards × ${config.shards[0].nodes.length} Raft replicas · data dir: ${path.resolve(config.dataDir)}\n`);
  fs.mkdirSync(config.dataDir, { recursive: true });
  app.listen(config.services.supervisor.port, config.services.supervisor.host);

  services.forEach((svc, i) => launch(svc.name, svc.args, COLORS[i % COLORS.length]));

  // Wait until every shard has elected a leader.
  const gw = urlOf(config.services.gateway);
  for (let i = 0; i < 120; i++) {
    const r = await httpJson(`${gw}/health`).catch(() => null);
    if (r?.data?.ready) break;
    await sleep(500);
  }

  const marker = path.join(config.dataDir, '.seeded');
  if (!fs.existsSync(marker)) {
    console.log('\x1b[33mSeeding demo data through the public API…\x1b[0m');
    try {
      await seed(gw);
      fs.writeFileSync(marker, new Date().toISOString());
    } catch (err) {
      console.error('Seeding failed:', err.message);
    }
  }

  console.log(`
\x1b[1m\x1b[32m  ✔ MediChain is running →  ${gw}\x1b[0m

  Demo accounts:
    admin     / Admin@123     Ops Console (cluster, chaos lab, audit ledger)
    dr.rohit  / Doctor@123    Cardiologist (treating physician)
    dr.varun  / Doctor@123    Emergency physician (no consent → try break-glass)
    hemanth   / Patient@123   Patient portal
    sanku     / Patient@123   Patient portal

  Press Ctrl+C to stop.
`);
  ready = true;
}

main();
