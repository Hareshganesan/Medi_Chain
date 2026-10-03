import express from 'express';
import path from 'node:path';
import { RaftNode } from './raft-node.js';
import { FileStorage, MemoryStorage } from './storage.js';
import { KVStateMachine } from './kv-state-machine.js';
import { HttpTransport } from './transport.js';
import { createLogger } from '../common/logger.js';
import { requireServiceToken, requestId, errorHandler, listen, closeServer } from '../common/security.js';

const RPC_ROUTES = { 'pre-vote': 'preVote', 'request-vote': 'requestVote', 'append-entries': 'appendEntries' };

/** HTTP surface of one replica: Raft RPCs, client KV API, and admin/inspection endpoints. */
export function createStorageNodeApp(node, { token, peerUrls }) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(requestId);

  app.get('/health', (req, res) => res.json({ ok: true, id: node.id }));
  app.get('/status', (req, res) => res.json(node.status()));

  app.use(requireServiceToken(token));

  app.post('/raft/:rpc', (req, res) => {
    const type = RPC_ROUTES[req.params.rpc];
    if (!type) return res.status(404).json({ error: 'UNKNOWN_RPC' });
    try {
      res.json(node.handle(type, req.body));
    } catch (err) {
      res.status(503).json({ error: err.code || 'UNAVAILABLE', message: err.message });
    }
  });

  const sendRaftError = (res, err) => {
    if (err.code === 'NOT_LEADER') {
      return res.status(421).json({ error: 'NOT_LEADER', leaderId: err.leaderId, leaderUrl: peerUrls[err.leaderId] ?? null });
    }
    if (err.code === 'NO_QUORUM' || err.code === 'ISOLATED') return res.status(503).json({ error: 'NO_QUORUM', message: err.message });
    throw err;
  };

  app.post('/kv/command', async (req, res) => {
    const command = { ...req.body.command, ts: req.body.command?.ts ?? new Date().toISOString() };
    try {
      const { result, index, term } = await node.propose(command);
      if (result?.ok === false) return res.status(409).json({ error: result.error, result, index });
      res.json({ ok: true, result, index, term, leaderId: node.id });
    } catch (err) {
      sendRaftError(res, err);
    }
  });

  app.get('/kv/get', (req, res) => {
    try {
      const value = node.read((sm) => sm.get(String(req.query.key)), req.query.consistency || 'strong');
      res.json({ entry: value, servedBy: node.id, role: node.role, commitIndex: node.commitIndex });
    } catch (err) {
      sendRaftError(res, err);
    }
  });

  app.get('/kv/scan', (req, res) => {
    try {
      const entries = node.read((sm) => sm.scan(String(req.query.prefix ?? '')), req.query.consistency || 'strong');
      res.json({ entries, servedBy: node.id, role: node.role });
    } catch (err) {
      sendRaftError(res, err);
    }
  });

  app.post('/admin/isolate', (req, res) => {
    node.setIsolated(Boolean(req.body.isolated));
    res.json(node.status());
  });

  /** Raw replicated log — shows that sensitive fields are stored as ciphertext. */
  app.get('/admin/log', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 200);
    res.json({ id: node.id, commitIndex: node.commitIndex, entries: node.log.slice(-limit).reverse() });
  });

  app.use(errorHandler());
  return app;
}

/**
 * Boot one replica. `peers` is [{ id, url }] for the other members of the shard.
 * Pass `dataDir: null` for in-memory storage (tests).
 */
export async function startStorageNode({
  id,
  shardId,
  port = 0,
  peers,
  token,
  dataDir,
  storage,
  raft = {},
  logger = createLogger(`${shardId}/${id}`),
}) {
  const peerUrls = Object.fromEntries(peers.map((p) => [p.id, p.url]));
  const node = new RaftNode({
    id,
    peers: peers.map((p) => p.id),
    transport: new HttpTransport({ peers: peerUrls, token, timeoutMs: Math.max(300, raft.heartbeatInterval * 3 || 800) }),
    storage: storage ?? (dataDir ? new FileStorage(path.join(dataDir, 'raft', shardId, id)) : new MemoryStorage()),
    stateMachine: new KVStateMachine(),
    ...raft,
    logger,
  });
  const app = createStorageNodeApp(node, { token, peerUrls });
  const server = await listen(app, port);
  node.start();
  return {
    node,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      node.stop();
      await closeServer(server);
    },
  };
}
