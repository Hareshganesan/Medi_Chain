import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { startAuthService } from '../../src/auth/auth-service.js';
import { startEventBus } from '../../src/eventbus/event-bus.js';
import { startAuditService } from '../../src/audit/audit-service.js';
import { EventPublisher, startConsumer } from '../../src/common/event-client.js';
import { httpJson } from '../../src/common/http.js';
import { verifyToken } from '../../src/common/security.js';
import { waitUntil } from '../helpers/stack.js';

const TOKEN = 'svc-token';
const H = { 'x-service-token': TOKEN };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'medichain-svc-'));

describe('Auth service (integration)', () => {
  let auth;
  let clock;
  let dir;
  beforeAll(async () => {
    dir = tmp();
    clock = { t: Date.now() };
    auth = await startAuthService({ token: TOKEN, dataDir: dir, maxFailedAttempts: 3, lockoutMs: 60000, now: () => clock.t });
  });
  afterAll(async () => {
    await auth.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = (username, password) => httpJson(`${auth.url}/login`, { method: 'POST', body: { username, password } });

  it('TC-AUTH-01: valid credentials return an RS256 JWT with role claims', async () => {
    const r = await login('dr.rohit', 'Doctor@123');
    expect(r.status).toBe(200);
    const claims = verifyToken(r.data.token, auth.publicKey);
    expect(claims).toMatchObject({ sub: 'D-ROHIT', role: 'doctor', iss: 'medichain-auth' });
    expect(jwt.decode(r.data.token, { complete: true }).header.alg).toBe('RS256');
    expect(r.data.user.passwordHash).toBeUndefined();
  });

  it('TC-AUTH-02: unknown user and wrong password give the SAME error (no user enumeration)', async () => {
    const a = await login('nobody', 'Whatever@1');
    const b = await login('dr.varun', 'Wrong@1234');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.data.error).toBe(b.data.error);
    expect(a.data.message).toBe(b.data.message);
  });

  it('TC-AUTH-03 (BVA): account locks on the Nth failure (N=3), not before; lock expires', async () => {
    const r1 = await login('dr.nikhil', 'bad');
    const r2 = await login('dr.nikhil', 'bad');
    expect([r1.status, r2.status]).toEqual([401, 401]);
    expect(r2.data.details[0].attemptsLeft).toBe(1);
    const r3 = await login('dr.nikhil', 'bad');
    expect(r3.status).toBe(423);
    // even the correct password is refused while locked
    expect((await login('dr.nikhil', 'Doctor@123')).status).toBe(423);
    clock.t += 60001;
    expect((await login('dr.nikhil', 'Doctor@123')).status).toBe(200);
  });

  it('TC-AUTH-04: a successful login resets the failure counter', async () => {
    await login('admin', 'bad');
    await login('admin', 'bad');
    expect((await login('admin', 'Admin@123')).status).toBe(200);
    const r = await login('admin', 'bad');
    expect(r.data.details[0].attemptsLeft).toBe(2);
    await login('admin', 'Admin@123');
  });

  it('TC-AUTH-05: malformed body → 400; internal API requires the service token', async () => {
    expect((await httpJson(`${auth.url}/login`, { method: 'POST', body: { username: '' } })).status).toBe(400);
    expect((await httpJson(`${auth.url}/internal/users`)).status).toBe(401);
    expect((await httpJson(`${auth.url}/internal/users`, { headers: { 'x-service-token': 'wrong' } })).status).toBe(401);
    const r = await httpJson(`${auth.url}/internal/users?role=doctor`, { headers: H });
    expect(r.data.users.map((u) => u.id).sort()).toEqual(['D-NIKHIL', 'D-ROHIT', 'D-VARUN']);
  });

  it('TC-AUTH-06: creates patient accounts, rejects duplicates and weak passwords; users persist', async () => {
    const body = { username: 'newpatient', password: 'Strong@123', name: 'New Patient', patientId: 'P-NEW1' };
    expect((await httpJson(`${auth.url}/internal/users`, { method: 'POST', headers: H, body })).status).toBe(201);
    expect((await httpJson(`${auth.url}/internal/users`, { method: 'POST', headers: H, body })).status).toBe(409);
    expect((await httpJson(`${auth.url}/internal/users`, { method: 'POST', headers: H, body: { ...body, username: 'weak', password: 'password' } })).status).toBe(400);
    const r = await login('newpatient', 'Strong@123');
    expect(verifyToken(r.data.token, auth.publicKey).patientId).toBe('P-NEW1');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'auth', 'users.json'), 'utf8'));
    expect(saved.some((u) => u.username === 'newpatient' && u.passwordHash.startsWith('$2'))).toBe(true);
  });

  it('TC-AUTH-07: tokens signed with another key or with alg=none are rejected', () => {
    const forged = jwt.sign({ sub: 'U-ADMIN', role: 'admin' }, 'guessable-secret', { algorithm: 'HS256', issuer: 'medichain-auth' });
    expect(() => verifyToken(forged, auth.publicKey)).toThrow();
    const none = jwt.sign({ sub: 'x', role: 'admin', iss: 'medichain-auth' }, '', { algorithm: 'none' });
    expect(() => verifyToken(none, auth.publicKey)).toThrow();
  });
});

describe('Event bus (integration)', () => {
  let bus;
  let dir;
  beforeAll(async () => {
    dir = tmp();
    bus = await startEventBus({ token: TOKEN, dataDir: dir });
  });
  afterAll(async () => {
    await bus.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const publish = (topic, value) => httpJson(`${bus.url}/topics/${topic}/messages`, { method: 'POST', headers: H, body: { value } });
  const poll = (topic, group, extra = '') => httpJson(`${bus.url}/topics/${topic}/messages?group=${group}${extra}`, { headers: H, timeoutMs: 10000 });

  it('TC-BUS-01: assigns monotonically increasing offsets', async () => {
    const offsets = [];
    for (let i = 0; i < 3; i++) offsets.push((await publish('t1', { i })).data.offset);
    expect(offsets).toEqual([0, 1, 2]);
  });

  it('TC-BUS-02: consumer groups are independent — every group receives every message (fan-out)', async () => {
    const a = await poll('t1', 'audit');
    const b = await poll('t1', 'notify');
    expect(a.data.messages.map((m) => m.value.i)).toEqual([0, 1, 2]);
    expect(b.data.messages).toHaveLength(3);
  });

  it('TC-BUS-03: committed offsets survive; uncommitted messages are redelivered (at-least-once)', async () => {
    await httpJson(`${bus.url}/topics/t1/offsets`, { method: 'POST', headers: H, body: { group: 'audit', offset: 2 } });
    expect((await poll('t1', 'audit')).data.messages.map((m) => m.offset)).toEqual([2]);
    expect((await poll('t1', 'notify')).data.messages).toHaveLength(3); // never committed → replayed
  });

  it('TC-BUS-04: long-poll returns as soon as a message is published', async () => {
    await httpJson(`${bus.url}/topics/t2/offsets`, { method: 'POST', headers: H, body: { group: 'g', offset: 0 } });
    const t0 = Date.now();
    const pending = poll('t2', 'g', '&waitMs=5000');
    setTimeout(() => publish('t2', { hello: 1 }), 150);
    const r = await pending;
    expect(r.data.messages[0].value).toEqual({ hello: 1 });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('TC-BUS-05: reports per-group lag', async () => {
    const r = await httpJson(`${bus.url}/topics`, { headers: H });
    const t1 = r.data.topics.find((t) => t.name === 't1');
    expect(t1.endOffset).toBe(3);
    expect(t1.groups.find((g) => g.group === 'audit').lag).toBe(1);
  });

  it('TC-BUS-06: messages and offsets persist across a broker restart', async () => {
    await bus.close();
    bus = await startEventBus({ token: TOKEN, dataDir: dir });
    expect((await poll('t1', 'audit')).data.messages.map((m) => m.offset)).toEqual([2]);
  });

  it('TC-BUS-07: requires the service token', async () => {
    expect((await httpJson(`${bus.url}/topics`)).status).toBe(401);
  });
});

describe('Producer outbox & consumer loop (integration)', () => {
  it('TC-BUS-08: publisher buffers while the broker is DOWN and delivers once it is back', async () => {
    const dir = tmp();
    let bus = await startEventBus({ token: TOKEN, dataDir: dir });
    const port = bus.server.address().port;
    await bus.close();
    const pub = new EventPublisher({ busUrl: `http://127.0.0.1:${port}`, token: TOKEN });
    pub.publish('outbox', { type: 'A' });
    pub.publish('outbox', { type: 'B' });
    await new Promise((r) => setTimeout(r, 300));
    expect(pub.queue.length).toBe(2);
    expect(pub.stats.failedAttempts).toBeGreaterThan(0);
    bus = await startEventBus({ token: TOKEN, dataDir: dir, port });
    await pub.drain(8000);
    expect(pub.queue.length).toBe(0);
    const r = await httpJson(`${bus.url}/topics/outbox/messages?group=x`, { headers: H });
    expect(r.data.messages.map((m) => m.value.type)).toEqual(['A', 'B']);
    await bus.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('TC-BUS-09: consumer processes messages in order and commits offsets', async () => {
    const bus = await startEventBus({ token: TOKEN });
    const seen = [];
    const c = startConsumer({ busUrl: bus.url, token: TOKEN, topic: 'ord', group: 'g1', handler: (v) => seen.push(v.n), waitMs: 200 });
    for (let n = 0; n < 5; n++) await httpJson(`${bus.url}/topics/ord/messages`, { method: 'POST', headers: H, body: { value: { n } } });
    await waitUntil(() => seen.length === 5);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    await waitUntil(async () => (await httpJson(`${bus.url}/topics`, { headers: H })).data.topics[0].groups[0]?.lag === 0);
    await c.stop();
    await bus.close();
  });
});

describe('Audit service (integration)', () => {
  let bus;
  let audit;
  beforeAll(async () => {
    bus = await startEventBus({ token: TOKEN });
    audit = await startAuditService({ token: TOKEN, busUrl: bus.url });
  });
  afterAll(async () => {
    await audit.close();
    await bus.close();
  });

  it('TC-AUDIT-01: events published on the bus land in the hash-chained ledger', async () => {
    for (const [i, type] of ['RECORD_READ', 'ACCESS_DENIED', 'RECORD_READ'].entries()) {
      await httpJson(`${bus.url}/topics/ehr.events/messages`, {
        method: 'POST',
        headers: H,
        body: { value: { id: `e${i}`, type, patientId: i === 1 ? 'P2' : 'P1', actor: { id: 'D-1' } } },
      });
    }
    await waitUntil(() => audit.chain().length === 3);
    const v = await httpJson(`${audit.url}/audit/verify`, { headers: H });
    expect(v.data).toMatchObject({ valid: true, length: 3 });
  });

  it('TC-AUDIT-02: redelivered events are not appended twice (idempotent consumer)', async () => {
    await httpJson(`${audit.url}/append`, { method: 'POST', headers: H, body: { id: 'e0', type: 'RECORD_READ' } });
    expect(audit.chain()).toHaveLength(3);
  });

  it('TC-AUDIT-03: filters by patient and type', async () => {
    const r = await httpJson(`${audit.url}/audit?patientId=P1&type=RECORD_READ`, { headers: H });
    expect(r.data.total).toBe(2);
  });

  it('TC-AUDIT-04: tampering is detected; restore makes the chain valid again', async () => {
    await httpJson(`${audit.url}/audit/tamper`, { method: 'POST', headers: H, body: { index: 1 } });
    const bad = await httpJson(`${audit.url}/audit/verify`, { headers: H });
    expect(bad.data).toMatchObject({ valid: false, brokenAt: 1 });
    await httpJson(`${audit.url}/audit/restore`, { method: 'POST', headers: H, body: {} });
    expect((await httpJson(`${audit.url}/audit/verify`, { headers: H })).data.valid).toBe(true);
    expect((await httpJson(`${audit.url}/audit/tamper`, { method: 'POST', headers: H, body: { index: 999 } })).status).toBe(404);
  });

  it('TC-AUDIT-05: tamper endpoint is disabled outside demo mode', async () => {
    const strict = await startAuditService({ token: TOKEN, demoMode: false });
    expect((await httpJson(`${strict.url}/audit/tamper`, { method: 'POST', headers: H, body: {} })).status).toBe(403);
    await strict.close();
  });
});
