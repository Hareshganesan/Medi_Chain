import express from 'express';
import { createLogger } from '../common/logger.js';
import { requestId, errorHandler, listen, closeServer, verifyToken, bearer } from '../common/security.js';
import { startConsumer } from '../common/event-client.js';
import { httpJson, retry } from '../common/http.js';

const PATIENT_FACING = new Set(['RECORD_READ', 'RECORD_CREATED', 'BREAK_GLASS', 'ACCESS_DENIED']);

/** Who should see this event? Pure function, unit-tested. */
export function audienceFor(event, user) {
  if (user.role === 'admin') return true;
  if (event.topic === 'cluster.events') return false;
  if (user.role === 'patient') {
    return event.patientId === user.patientId && event.actor?.id !== user.sub && PATIENT_FACING.has(event.type);
  }
  if (user.role === 'doctor') {
    return ['CONSENT_GRANTED', 'CONSENT_REVOKED'].includes(event.type) && event.details?.doctorId === user.sub;
  }
  return false;
}

/**
 * Real-time push: consumes the event bus in its own consumer group and fans
 * events out to connected browsers over Server-Sent Events. Verifies JWTs itself
 * with the auth public key (zero-trust: it does not trust the gateway blindly).
 */
export async function startNotifyService({ port = 0, token, busUrl, authUrl, logger = createLogger('notify') } = {}) {
  const { data } = await retry(() => httpJson(`${authUrl}/public-key`).then((r) => (r.ok ? r : Promise.reject(new Error('auth not ready')))), {
    retries: 30,
    baseDelayMs: 200,
    maxDelayMs: 1000,
  });
  const publicKey = data.publicKey;
  const clients = new Set();
  const recent = []; // last events, replayed to newly connected admins

  const dispatch = (event) => {
    recent.push(event);
    if (recent.length > 200) recent.shift();
    for (const c of clients) if (audienceFor(event, c.user)) c.res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const consumers = ['ehr.events', 'cluster.events'].map((topic) =>
    startConsumer({ busUrl, token, topic, group: 'notify-service', handler: (v) => dispatch({ ...v, topic }), logger, waitMs: 5000 }),
  );

  const app = express();
  app.use(requestId);
  app.get('/health', (req, res) => res.json({ ok: true, clients: clients.size }));

  app.get('/stream', (req, res) => {
    let user;
    try {
      user = verifyToken(bearer(req), publicKey);
    } catch {
      return res.status(401).json({ error: 'INVALID_TOKEN' });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ connected: true, role: user.role })}\n\n`);
    for (const e of recent.slice(-30)) if (audienceFor(e, user)) res.write(`data: ${JSON.stringify({ ...e, replay: true })}\n\n`);
    const client = { res, user };
    clients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
    });
  });

  app.use(errorHandler(logger));
  const server = await listen(app, port);
  logger.info(`notification service listening on :${server.address().port}`);
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await Promise.all(consumers.map((c) => c.stop()));
      for (const c of clients) c.res.end();
      await closeServer(server);
    },
  };
}
