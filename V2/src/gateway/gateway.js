import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../common/logger.js';
import { requestId, errorHandler, listen, closeServer, verifyToken, bearer, HttpError } from '../common/security.js';
import { TokenBucketLimiter, rateLimit } from '../common/rate-limiter.js';
import { LRUCache } from '../common/lru-cache.js';
import { Metrics } from '../common/metrics.js';
import { httpJson, retry } from '../common/http.js';
import { authorize, ACTIONS } from '../common/rbac.js';
import { validate, patientSchema, recordSchema, breakGlassSchema, consentSchema, loginSchema } from '../common/validation.js';
import { EventPublisher } from '../common/event-client.js';
import { ShardRouter } from './shard-client.js';
import { hash32 } from '../common/consistent-hash.js';
import { ClusterMonitor } from './cluster-monitor.js';
import { EhrRepository, ageFrom } from './ehr-repository.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const BREAK_GLASS_MINUTES = 30;

/**
 * API Gateway — the single entry point (slide 5).
 * TLS termination would sit in front of this in production (NGINX / cloud LB).
 */
export async function startGateway({
  port = 0,
  shards,
  authUrl,
  busUrl,
  auditUrl,
  notifyUrl,
  controlPlane = null, // { kill(nodeId), restart(nodeId) } — the supervisor in production
  internalToken: token,
  encryptionKey,
  demoMode = true,
  cacheTtlMs = 30000,
  rateLimitOptions = { capacity: 120, refillPerSec: 40 },
  loginRateLimitOptions = { capacity: 10, refillPerSec: 0.5 },
  monitorIntervalMs = 1000,
  shardClientOptions = {},
  logger = createLogger('gateway'),
} = {}) {
  const metrics = new Metrics();
  const cache = new LRUCache({ max: 1000, ttlMs: cacheTtlMs });
  const publisher = new EventPublisher({ busUrl, token, logger });
  const router = new ShardRouter({ shards, token, clientOptions: shardClientOptions });
  const repo = new EhrRepository({ router, encryptionKey, cache });
  const monitor = new ClusterMonitor({ router, publisher, intervalMs: monitorIntervalMs }).start();
  const apiLimiter = new TokenBucketLimiter(rateLimitOptions);
  const loginLimiter = new TokenBucketLimiter(loginRateLimitOptions);
  const internal = { 'x-service-token': token };

  // ─── helpers ───
  let publicKeyPromise;
  const publicKey = () => {
    publicKeyPromise ??= retry(
      async () => {
        const r = await httpJson(`${authUrl}/public-key`);
        if (!r.ok) throw new Error('auth service unavailable');
        return r.data.publicKey;
      },
      { retries: 20, baseDelayMs: 200, maxDelayMs: 1000 },
    ).catch((err) => {
      publicKeyPromise = null;
      throw err;
    });
    return publicKeyPromise;
  };

  let doctorCache = { at: 0, list: [] };
  const doctors = async () => {
    if (Date.now() - doctorCache.at < 60000 && doctorCache.list.length) return doctorCache.list;
    const r = await httpJson(`${authUrl}/internal/users?role=doctor`, { headers: internal });
    if (!r.ok) throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Identity service unavailable');
    doctorCache = { at: Date.now(), list: r.data.users };
    return doctorCache.list;
  };

  const actorOf = (user) => (user ? { id: user.sub, name: user.name, role: user.role } : { id: 'anonymous', name: 'anonymous', role: 'none' });

  /** Every security-relevant action is published → audit ledger + notifications. */
  const audit = (req, type, extra = {}) =>
    publisher.publish('ehr.events', { type, actor: actorOf(req.user), requestId: req.id, ip: req.ip, outcome: 'ALLOW', ...extra }, extra.patientId);

  const deny = (req, decision, patientId, status = 403) => {
    audit(req, 'ACCESS_DENIED', { patientId, outcome: 'DENY', reason: decision.reason, details: { path: req.path, method: req.method } });
    throw new HttpError(status, 'ACCESS_DENIED', 'You are not authorised to access this resource', {
      details: [{ reason: decision.reason, canBreakGlass: req.user?.role === 'doctor' }],
    });
  };

  const authenticate = async (req, res, next) => {
    const t = bearer(req);
    if (!t) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Missing bearer token' });
    try {
      req.user = verifyToken(t, await publicKey());
      next();
    } catch (err) {
      if (err.code === 'SHARD_UNAVAILABLE' || err.message === 'auth service unavailable') return next(err);
      res.status(401).json({ error: 'INVALID_TOKEN', message: 'Token is invalid or expired' });
    }
  };

  const requireRole =
    (...roles) =>
    (req, res, next) => {
      if (roles.includes(req.user.role)) return next();
      deny(req, { reason: `ROLE_${req.user.role.toUpperCase()}_NOT_ALLOWED` }, req.params.id);
    };

  const timing = (req, view) => ({
    shardId: view.shardId,
    servedBy: view.servedBy,
    cache: view.cache,
    storageMs: view.storageMs ?? 0,
  });

  // ─── app & middleware ───
  const app = express();
  app.set('trust proxy', 'loopback'); // honour X-Forwarded-For from a local load balancer
  app.disable('x-powered-by');
  app.use(requestId);
  app.use((req, res, next) => {
    const t0 = performance.now();
    res.on('finish', () => {
      const route = req.route ? (req.baseUrl || '') + req.route.path : req.path.startsWith('/api') ? 'unmatched' : 'static';
      metrics.recordRequest(route, res.statusCode, performance.now() - t0);
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.get('/health', (req, res) => {
    const topo = monitor.topology();
    res.json({ ok: true, ready: monitor.allShardsHaveLeader(), shards: topo.map((s) => ({ id: s.id, leaderId: s.leaderId, term: s.term })) });
  });

  app.get('/metrics', (req, res) => {
    res.type('text/plain; version=0.0.4').send(
      metrics.toPrometheus() +
        `# TYPE cache_hit_ratio gauge\ncache_hit_ratio ${cache.snapshot().hitRatio}\n` +
        `# TYPE events_published_total counter\nevents_published_total ${publisher.stats.published}\n`,
    );
  });

  // ─── auth ───
  app.post(
    '/api/auth/login',
    rateLimit(loginLimiter, (req) => `login:${req.ip}`, (req) => audit(req, 'RATE_LIMITED', { outcome: 'DENY', details: { path: req.path } })),
    async (req, res) => {
      const body = validate(loginSchema, req.body);
      const r = await httpJson(`${authUrl}/login`, { method: 'POST', body, headers: { 'x-request-id': req.id } }).catch(() => {
        throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Identity service unavailable');
      });
      if (r.ok) {
        req.user = { sub: r.data.user.id, name: r.data.user.name, role: r.data.user.role };
        audit(req, 'AUTH_LOGIN_SUCCESS', { patientId: r.data.user.patientId });
      } else audit(req, r.status === 423 ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_LOGIN_FAILURE', { outcome: 'DENY', details: { username: body.username } });
      res.status(r.status).json(r.data);
    },
  );

  const api = express.Router();
  api.use(authenticate);
  api.use(rateLimit(apiLimiter, (req) => `user:${req.user.sub}`, (req) => audit(req, 'RATE_LIMITED', { outcome: 'DENY' })));

  api.get('/auth/me', (req, res) => res.json({ user: req.user }));

  api.get('/doctors', requireRole('doctor', 'patient'), async (req, res) => {
    res.json({ doctors: (await doctors()).map(({ id, name, title }) => ({ id, name, title })) });
  });

  // ─── patients ───
  api.get('/patients', requireRole('doctor'), async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const { patients, degraded, tookMs } = await repo.directory(req.id);
    const now = Date.now();
    const list = patients
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .map((p) => {
        const decision = authorize(req.user, ACTIONS.PATIENT_READ, { consents: p.consents, now });
        const grant = p.consents[req.user.sub];
        return {
          id: p.id,
          name: p.name,
          gender: p.gender,
          age: ageFrom(p.dob),
          bloodGroup: p.bloodGroup,
          shardId: p.shardId,
          access: decision.allow ? grant.type : null,
          accessExpiresAt: decision.allow ? (grant.expiresAt ?? null) : null,
        };
      })
      .sort((a, b) => Number(Boolean(b.access)) - Number(Boolean(a.access)) || a.name.localeCompare(b.name));
    res.json({ patients: list, degraded, tookMs, shardsQueried: router.all().length });
  });

  api.post('/patients', requireRole('doctor'), async (req, res) => {
    const input = validate(patientSchema, req.body);
    const id = repo.newPatientId();
    if (input.account) {
      const r = await httpJson(`${authUrl}/internal/users`, {
        method: 'POST',
        headers: internal,
        body: { ...input.account, name: input.name, patientId: id },
      });
      if (r.status === 409) throw new HttpError(409, 'USERNAME_TAKEN', 'That portal username is already taken');
      if (!r.ok) throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Could not create the patient portal account');
    }
    const { shardId } = await repo.createPatient({ ...input, id }, req.user, req.id);
    audit(req, 'PATIENT_REGISTERED', { patientId: id, details: { shardId } });
    res.status(201).json({ id, shardId, account: input.account ? input.account.username : null });
  });

  /** Load a patient and run the RBAC/ABAC decision; audits both allow and deny. */
  const loadAuthorized = async (req, action) => {
    const patientId = req.params.id;
    if (req.user.role === 'patient' && req.user.patientId !== patientId) deny(req, { reason: 'NOT_OWNER' }, patientId);
    const view = await repo.getPatientView(patientId, req.id);
    if (!view) throw new HttpError(404, 'PATIENT_NOT_FOUND', 'No such patient');
    const decision = authorize(req.user, action, { patientId, consents: view.consents });
    if (!decision.allow) deny(req, decision, patientId);
    return { view, decision };
  };

  api.get('/patients/:id', requireRole('doctor', 'patient'), async (req, res) => {
    const t0 = performance.now();
    const { view, decision } = await loadAuthorized(req, ACTIONS.PATIENT_READ);
    audit(req, 'RECORD_READ', { patientId: req.params.id, reason: decision.reason, details: { breakGlass: decision.reason === 'BREAK_GLASS_ACTIVE' } });
    const owner = req.user.role === 'patient';
    const body = repo.present(view, { owner });
    const grant = view.consents[req.user.sub];
    res.setHeader('X-Cache', view.cache);
    res.setHeader('X-Shard', view.shardId);
    res.json({
      ...body,
      access: owner ? { type: 'owner' } : { type: grant.type, expiresAt: grant.expiresAt ?? null, reason: decision.reason },
      meta: { ...timing(req, view), totalMs: Math.round(performance.now() - t0), consistency: view.cache === 'HIT' ? 'cached' : 'linearizable' },
    });
  });

  api.post('/patients/:id/records', requireRole('doctor'), async (req, res) => {
    await loadAuthorized(req, ACTIONS.RECORD_CREATE);
    const record = validate(recordSchema, req.body);
    const out = await repo.addRecord(req.params.id, record, req.user, req.get('idempotency-key'), req.id);
    if (!out.duplicate) audit(req, 'RECORD_CREATED', { patientId: req.params.id, details: { recordType: record.type, title: record.title } });
    res.status(out.duplicate ? 200 : 201).json({ record: out.record, duplicate: out.duplicate, shardId: out.shardId, servedBy: out.servedBy, logIndex: out.index });
  });

  api.post('/patients/:id/break-glass', requireRole('doctor'), async (req, res) => {
    const { reason } = validate(breakGlassSchema, req.body);
    const decision = authorize(req.user, ACTIONS.BREAK_GLASS, { reason });
    if (!decision.allow) deny(req, decision, req.params.id);
    const view = await repo.getPatientView(req.params.id, req.id);
    if (!view) throw new HttpError(404, 'PATIENT_NOT_FOUND', 'No such patient');
    const expiresAt = new Date(Date.now() + BREAK_GLASS_MINUTES * 60000).toISOString();
    await repo.setConsent(
      req.params.id,
      req.user.sub,
      { type: 'breakglass', doctorName: req.user.name, reason, grantedAt: new Date().toISOString(), expiresAt },
      req.id,
    );
    audit(req, 'BREAK_GLASS', { patientId: req.params.id, reason, severity: 'HIGH', details: { expiresAt, justification: reason } });
    res.status(201).json({ granted: true, expiresAt, minutes: BREAK_GLASS_MINUTES });
  });

  // ─── consent (patient-controlled) ───
  api.get('/patients/:id/consents', requireRole('patient'), async (req, res) => {
    const { view } = await loadAuthorized(req, ACTIONS.CONSENT_MANAGE);
    const now = Date.now();
    const list = Object.entries(view.consents).map(([doctorId, g]) => ({
      doctorId,
      ...g,
      active: !g.expiresAt || new Date(g.expiresAt).getTime() > now,
    }));
    res.json({ consents: list });
  });

  api.post('/patients/:id/consents', requireRole('patient'), async (req, res) => {
    await loadAuthorized(req, ACTIONS.CONSENT_MANAGE);
    const { doctorId } = validate(consentSchema, req.body);
    const doctor = (await doctors()).find((d) => d.id === doctorId);
    if (!doctor) throw new HttpError(404, 'DOCTOR_NOT_FOUND', 'No such doctor');
    await repo.setConsent(req.params.id, doctorId, { type: 'consent', doctorName: doctor.name, grantedAt: new Date().toISOString(), grantedBy: req.user.sub }, req.id);
    audit(req, 'CONSENT_GRANTED', { patientId: req.params.id, details: { doctorId, doctorName: doctor.name } });
    res.status(201).json({ granted: true, doctorId });
  });

  api.delete('/patients/:id/consents/:doctorId', requireRole('patient'), async (req, res) => {
    await loadAuthorized(req, ACTIONS.CONSENT_MANAGE);
    await repo.setConsent(req.params.id, req.params.doctorId, null, req.id);
    audit(req, 'CONSENT_REVOKED', { patientId: req.params.id, details: { doctorId: req.params.doctorId } });
    res.json({ revoked: true, doctorId: req.params.doctorId });
  });

  api.get('/patients/:id/access-log', requireRole('patient'), async (req, res) => {
    if (req.user.patientId !== req.params.id) deny(req, { reason: 'NOT_OWNER' }, req.params.id);
    const r = await httpJson(`${auditUrl}/audit?patientId=${encodeURIComponent(req.params.id)}&limit=200`, { headers: internal });
    if (!r.ok) throw new HttpError(503, 'AUDIT_UNAVAILABLE', 'Audit service unavailable');
    const v = await httpJson(`${auditUrl}/audit/verify`, { headers: internal });
    res.json({
      entries: r.data.entries.map((e) => ({
        index: e.index,
        hash: e.hash,
        ts: e.data.ts,
        type: e.data.type,
        actor: e.data.actor,
        outcome: e.data.outcome,
        reason: e.data.reason,
        details: e.data.details,
      })),
      ledger: v.data,
    });
  });

  // ─── notifications (SSE proxied to the notification service) ───
  api.get('/notifications/stream', (req, res) => {
    const upstream = http.request(`${notifyUrl}/stream`, { headers: { authorization: req.get('authorization'), 'x-request-id': req.id } }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => res.headersSent ? res.end() : res.status(503).json({ error: 'NOTIFY_UNAVAILABLE' }));
    req.on('close', () => upstream.destroy());
    upstream.end();
  });

  // ─── admin / operations console ───
  const admin = express.Router();
  admin.use(requireRole('admin'));

  admin.get('/cluster', (req, res) => {
    res.json({
      shards: monitor.topology(),
      clients: router.all().map((c) => c.snapshot()),
      ring: router.ring.distribution(),
      ringPoints: router.ring.ring.map((v) => [v.pos, v.node]),
      events: monitor.events.slice(-40).reverse(),
      publisher: { ...publisher.stats, queued: publisher.queue.length },
      cache: cache.snapshot(),
    });
  });

  /** Where does a key live? Shows the consistent-hashing decision for the dashboard. */
  admin.get('/ring/lookup', (req, res) => {
    const key = String(req.query.key ?? '');
    if (!key) throw new HttpError(400, 'KEY_REQUIRED', 'Provide ?key=');
    res.json({ key, position: hash32(key), shardId: router.shardIdFor(key) });
  });

  admin.get('/metrics', (req, res) => {
    res.json({
      latency: metrics.latency(),
      throughput: metrics.throughput(60),
      requests: metrics.counterTotal('http_requests_total'),
      cache: cache.snapshot(),
      publisher: { ...publisher.stats, queued: publisher.queue.length },
    });
  });

  admin.post('/nodes/:nodeId/:action', async (req, res) => {
    const { nodeId, action } = req.params;
    const found = router.findNode(nodeId);
    if (!found) throw new HttpError(404, 'NO_SUCH_NODE', 'Unknown node');
    if (action === 'isolate' || action === 'heal') {
      const r = await httpJson(`${found.node.url}/admin/isolate`, { method: 'POST', headers: internal, body: { isolated: action === 'isolate' } }).catch(() => null);
      if (!r?.ok) throw new HttpError(503, 'NODE_UNREACHABLE', 'Node is not running');
    } else if (action === 'kill' || action === 'restart') {
      if (!controlPlane) throw new HttpError(501, 'NO_CONTROL_PLANE', 'Process control requires the supervisor');
      await controlPlane[action](nodeId);
    } else throw new HttpError(400, 'UNKNOWN_ACTION', 'Use kill, restart, isolate or heal');
    const type = { kill: 'NODE_KILLED', restart: 'NODE_RESTARTED', isolate: 'NODE_ISOLATED', heal: 'NODE_HEALED' }[action];
    monitor.emit(type, { shardId: found.shard.shardId, nodeId, by: req.user.name });
    setTimeout(() => monitor.tick(), 150);
    res.json({ ok: true, nodeId, action });
  });

  admin.get('/nodes/:nodeId/log', async (req, res) => {
    const found = router.findNode(req.params.nodeId);
    if (!found) throw new HttpError(404, 'NO_SUCH_NODE', 'Unknown node');
    const r = await httpJson(`${found.node.url}/admin/log?limit=${Number(req.query.limit) || 15}`, { headers: internal }).catch(() => null);
    if (!r?.ok) throw new HttpError(503, 'NODE_UNREACHABLE', 'Node is not running');
    res.json(r.data);
  });

  /** Write a probe through Raft — the chaos lab calls this in a loop while nodes are killed. */
  admin.post('/probe', async (req, res) => {
    const client = router.clients.get(req.body.shardId);
    if (!client) throw new HttpError(404, 'NO_SUCH_SHARD', 'Unknown shard');
    const t0 = performance.now();
    const r = await client.command({ type: 'put', key: `probe:${client.shardId}`, value: { at: Date.now(), by: req.user.sub } }, req.id);
    res.json({ ok: r.status === 200, shardId: client.shardId, servedBy: r.servedBy, attempts: r.attempts, logIndex: r.data?.index, latencyMs: Math.round(performance.now() - t0) });
  });

  const auditProxy = (method, upstreamPath) => async (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    const r = await httpJson(`${auditUrl}${upstreamPath}${qs ? '?' + qs : ''}`, { method, headers: internal, body: method === 'POST' ? req.body : undefined }).catch(() => null);
    if (!r) throw new HttpError(503, 'AUDIT_UNAVAILABLE', 'Audit service unavailable');
    res.status(r.status).json(r.data);
  };
  admin.get('/audit', auditProxy('GET', '/audit'));
  admin.get('/audit/verify', auditProxy('GET', '/audit/verify'));
  admin.post('/audit/tamper', (req, res, next) => (demoMode ? next() : next(new HttpError(403, 'DEMO_MODE_DISABLED', 'Disabled'))), auditProxy('POST', '/audit/tamper'));
  admin.post('/audit/restore', auditProxy('POST', '/audit/restore'));

  admin.get('/eventbus', async (req, res) => {
    const r = await httpJson(`${busUrl}/topics`, { headers: internal }).catch(() => null);
    if (!r?.ok) throw new HttpError(503, 'EVENTBUS_UNAVAILABLE', 'Event bus unavailable');
    res.json(r.data);
  });

  api.use('/admin', admin);
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use(errorHandler(logger));

  const server = await listen(app, port);
  logger.info(`API gateway listening on http://127.0.0.1:${server.address().port}`);
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    router,
    monitor,
    cache,
    publisher,
    metrics,
    async close() {
      monitor.stop();
      await publisher.drain(1000);
      await closeServer(server);
    },
  };
}
