import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../common/logger.js';
import { requireServiceToken, requestId, errorHandler, listen, closeServer } from '../common/security.js';

/**
 * Kafka-style message broker (the async half of the communication model).
 *  - Topics are append-only logs persisted to disk; each message gets a monotonically increasing offset.
 *  - Consumer GROUPS track their own committed offset → every group sees every message (fan-out),
 *    and a crashed consumer resumes where it left off (at-least-once delivery).
 *  - Long polling: a consumer waits for new messages instead of busy-looping.
 */
export async function startEventBus({ port = 0, dataDir = null, token, logger = createLogger('event-bus') } = {}) {
  const dir = dataDir ? path.join(dataDir, 'eventbus') : null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const offsetsFile = dir && path.join(dir, 'offsets.json');

  const topics = new Map(); // name → { messages: [], waiters: Set }
  const offsets = offsetsFile && fs.existsSync(offsetsFile) ? JSON.parse(fs.readFileSync(offsetsFile, 'utf8')) : {}; // "topic|group" → next offset
  const topicFile = (name) => dir && path.join(dir, `${name.replace(/[^a-z0-9._-]/gi, '_')}.log`);

  const topic = (name) => {
    let t = topics.get(name);
    if (!t) {
      t = { messages: [], waiters: new Set() };
      const f = topicFile(name);
      if (f && fs.existsSync(f)) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line.trim()) t.messages.push(JSON.parse(line));
      }
      topics.set(name, t);
    }
    return t;
  };
  if (dir) for (const f of fs.readdirSync(dir)) if (f.endsWith('.log')) topic(f.slice(0, -4));

  const saveOffsets = () => offsetsFile && fs.writeFileSync(offsetsFile, JSON.stringify(offsets));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);
  app.get('/health', (req, res) => res.json({ ok: true, topics: topics.size }));
  app.use(requireServiceToken(token));

  app.post('/topics/:topic/messages', (req, res) => {
    const t = topic(req.params.topic);
    const msg = { offset: t.messages.length, key: req.body.key ?? null, value: req.body.value, ts: new Date().toISOString() };
    t.messages.push(msg);
    const f = topicFile(req.params.topic);
    if (f) fs.appendFileSync(f, JSON.stringify(msg) + '\n');
    for (const wake of t.waiters) wake();
    t.waiters.clear();
    res.status(201).json({ offset: msg.offset });
  });

  app.get('/topics/:topic/messages', async (req, res) => {
    const t = topic(req.params.topic);
    const group = String(req.query.group || 'default');
    const max = Math.min(Number(req.query.max) || 100, 500);
    const waitMs = Math.min(Number(req.query.waitMs) || 0, 25000);
    const key = `${req.params.topic}|${group}`;
    const from = req.query.from !== undefined ? Number(req.query.from) : (offsets[key] ?? 0);

    if (from >= t.messages.length && waitMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, waitMs);
        function done() {
          clearTimeout(timer);
          t.waiters.delete(done);
          resolve();
        }
        t.waiters.add(done);
        req.on('close', done);
      });
    }
    const messages = t.messages.slice(from, from + max);
    res.json({ messages, nextOffset: from + messages.length, endOffset: t.messages.length });
  });

  app.post('/topics/:topic/offsets', (req, res) => {
    const key = `${req.params.topic}|${req.body.group}`;
    offsets[key] = Math.max(offsets[key] ?? 0, Number(req.body.offset));
    saveOffsets();
    res.json({ committed: offsets[key] });
  });

  /** Topic sizes and per-group consumer lag — shown on the ops dashboard. */
  app.get('/topics', (req, res) => {
    const out = [...topics.entries()].map(([name, t]) => {
      const groups = Object.entries(offsets)
        .filter(([k]) => k.startsWith(name + '|'))
        .map(([k, off]) => ({ group: k.split('|')[1], offset: off, lag: t.messages.length - off }));
      return { name, endOffset: t.messages.length, groups };
    });
    res.json({ topics: out });
  });

  app.use(errorHandler(logger));
  const server = await listen(app, port);
  logger.info(`event bus listening on :${server.address().port}`);
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => closeServer(server) };
}
