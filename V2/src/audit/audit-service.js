import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../common/logger.js';
import { requireServiceToken, requestId, errorHandler, listen, closeServer, HttpError } from '../common/security.js';
import { createEntry, verifyChain } from '../common/hash-chain.js';
import { startConsumer } from '../common/event-client.js';

/**
 * Immutable, tamper-evident audit trail.
 * Consumes every security event from the bus and appends it to a SHA-256 hash
 * chain (each entry commits to the previous one, like a blockchain without mining).
 * Editing, deleting or re-ordering any past entry breaks verification.
 */
export async function startAuditService({ port = 0, dataDir = null, token, busUrl, demoMode = true, logger = createLogger('audit') } = {}) {
  const dir = dataDir ? path.join(dataDir, 'audit') : null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const ledgerFile = dir && path.join(dir, 'ledger.jsonl');

  let chain = [];
  if (ledgerFile && fs.existsSync(ledgerFile)) {
    chain = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  const seen = new Set(chain.map((e) => e.data.id)); // idempotent consumer: dedupe by event id
  const tampered = new Map(); // index → original data (demo undo only)

  const persistAll = () => ledgerFile && fs.writeFileSync(ledgerFile, chain.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const append = (event) => {
    if (!event?.id || seen.has(event.id)) return false;
    const entry = createEntry(chain[chain.length - 1], event);
    chain.push(entry);
    seen.add(event.id);
    if (ledgerFile) fs.appendFileSync(ledgerFile, JSON.stringify(entry) + '\n');
    return true;
  };

  const consumer = busUrl
    ? startConsumer({ busUrl, token, topic: 'ehr.events', group: 'audit-service', handler: append, logger })
    : null;

  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.get('/health', (req, res) => res.json({ ok: true, entries: chain.length }));
  app.use(requireServiceToken(token));

  app.post('/append', (req, res) => res.status(201).json({ appended: append(req.body) }));

  app.get('/audit', (req, res) => {
    const { patientId, actorId, type } = req.query;
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    let list = chain;
    if (patientId) list = list.filter((e) => e.data.patientId === patientId);
    if (actorId) list = list.filter((e) => e.data.actor?.id === actorId);
    if (type) list = list.filter((e) => e.data.type === type);
    res.json({ total: list.length, entries: list.slice(-limit).reverse() });
  });

  app.get('/audit/verify', (req, res) => res.json({ ...verifyChain(chain), checkedAt: new Date().toISOString() }));

  // ─── demo-only: simulate an insider editing history, then undo it ───
  app.post('/audit/tamper', (req, res) => {
    if (!demoMode) throw new HttpError(403, 'DEMO_MODE_DISABLED', 'Tampering demo is disabled');
    const index = req.body.index ?? Math.floor(chain.length / 2);
    const entry = chain[index];
    if (!entry) throw new HttpError(404, 'NO_SUCH_ENTRY', 'No audit entry at that index');
    if (!tampered.has(index)) tampered.set(index, structuredClone(entry.data));
    entry.data = { ...entry.data, actor: { ...entry.data.actor, name: 'Unknown Actor' }, outcome: 'ALLOW', tampered: true };
    persistAll();
    res.json({ tamperedIndex: index });
  });

  app.post('/audit/restore', (req, res) => {
    for (const [index, data] of tampered) chain[index].data = data;
    const restored = tampered.size;
    tampered.clear();
    persistAll();
    res.json({ restored });
  });

  app.use(errorHandler(logger));
  const server = await listen(app, port);
  logger.info(`audit service listening on :${server.address().port} (${chain.length} entries)`);
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    chain: () => chain,
    async close() {
      await consumer?.stop();
      await closeServer(server);
    },
  };
}
