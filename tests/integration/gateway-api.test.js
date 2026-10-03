import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { startStack, validPatient, waitUntil, TOKEN } from '../helpers/stack.js';
import { httpJson } from '../../src/common/http.js';

/**
 * System-level API tests: the full distributed system (gateway, auth, event bus,
 * audit, notify, 2 shards × 3 Raft replicas) running in-process on random ports.
 */
let stack;
let api;
const tokens = {};
const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
let hemanth; // { id, shardId }
const BULK_NAMES = ['Adithya', 'Balaji', 'Charan', 'Dhruv', 'Eshwar', 'Gokul', 'Harsha', 'Jeevan', 'Kiran', 'Lokesh', 'Manoj', 'Naveen', 'Pradeep', 'Rahul', 'Sachin', 'Tarun', 'Uday', 'Vignesh', 'Yash', 'Abhinav'];

beforeAll(async () => {
  stack = await startStack();
  api = request(stack.url);
  for (const [u, p] of [['dr.rohit', 'Doctor@123'], ['dr.varun', 'Doctor@123'], ['dr.nikhil', 'Doctor@123'], ['admin', 'Admin@123']]) tokens[u] = await stack.login(u, p);
  const res = await api.post('/api/patients').set(as('dr.rohit')).send(validPatient({ name: 'Hemanth', account: { username: 'hemanth', password: 'Patient@123' } }));
  hemanth = res.body;
  tokens.hemanth = await stack.login('hemanth', 'Patient@123');
});
afterAll(async () => stack?.stop());

describe('Authentication & sessions', () => {
  it('TC-API-01: login via the gateway returns a token and the user profile', async () => {
    const r = await api.post('/api/auth/login').send({ username: 'dr.varun', password: 'Doctor@123' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ role: 'doctor', name: 'Dr. Varun' });
  });

  it('TC-API-02: protected endpoints reject missing, malformed and forged tokens', async () => {
    expect((await api.get('/api/auth/me')).status).toBe(401);
    expect((await api.get('/api/auth/me').set('Authorization', 'Bearer not.a.jwt')).status).toBe(401);
    const [h, , s] = tokens['dr.varun'].split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'U-ADMIN', role: 'admin', iss: 'medichain-auth' })).toString('base64url');
    expect((await api.get('/api/admin/cluster').set('Authorization', `Bearer ${h}.${forgedPayload}.${s}`)).status).toBe(401);
  });

  it('TC-API-03: /api/auth/me echoes verified claims', async () => {
    const r = await api.get('/api/auth/me').set(as('hemanth'));
    expect(r.body.user).toMatchObject({ role: 'patient', patientId: hemanth.id });
  });
});

describe('Patient registration & sharding', () => {
  it('TC-API-04: doctor registers a patient; it is placed on the shard chosen by the hash ring', async () => {
    const r = await api.post('/api/patients').set(as('dr.rohit')).send(validPatient({ name: 'Maddan' }));
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^P-[0-9A-F]{6}$/);
    expect(r.body.shardId).toBe(stack.gateway.router.shardIdFor(r.body.id));
  });

  it('TC-API-05: invalid input is rejected with per-field errors (400)', async () => {
    const r = await api.post('/api/patients').set(as('dr.rohit')).send(validPatient({ phone: '123', dob: '2999-01-01' }));
    expect(r.status).toBe(400);
    expect(r.body.details.map((d) => d.path)).toEqual(expect.arrayContaining(['phone', 'dob']));
  });

  it('TC-API-06: patients and admins cannot register patients (403)', async () => {
    expect((await api.post('/api/patients').set(as('hemanth')).send(validPatient())).status).toBe(403);
    expect((await api.post('/api/patients').set(as('admin')).send(validPatient())).status).toBe(403);
  });

  it('TC-API-07: duplicate portal username → 409', async () => {
    const r = await api.post('/api/patients').set(as('dr.rohit')).send(validPatient({ account: { username: 'hemanth', password: 'Another@123' } }));
    expect(r.status).toBe(409);
  });

  it('TC-API-08: 20 patients spread across BOTH shards', async () => {
    const shards = new Set();
    for (let i = 0; i < 20; i++) {
      const r = await api.post('/api/patients').set(as('dr.nikhil')).send(validPatient({ name: BULK_NAMES[i] }));
      shards.add(r.body.shardId);
    }
    expect([...shards].sort()).toEqual(['shard-a', 'shard-b']);
  });

  it('TC-API-09: directory is a scatter-gather across all shards with access flags', async () => {
    const r = await api.get('/api/patients').set(as('dr.varun'));
    expect(r.status).toBe(200);
    expect(r.body.shardsQueried).toBe(2);
    expect(r.body.degraded).toEqual([]);
    const row = r.body.patients.find((p) => p.id === hemanth.id);
    expect(row).toMatchObject({ name: 'Hemanth', access: null });
    expect(row.phone).toBeUndefined(); // directory never leaks PHI
    const search = await api.get('/api/patients?q=hemanth').set(as('dr.rohit'));
    expect(search.body.patients.map((p) => p.id)).toEqual([hemanth.id]);
  });
});

describe('Access control (RBAC + consent + break-glass)', () => {
  it('TC-API-10: treating doctor reads the full decrypted record', async () => {
    const r = await api.get(`/api/patients/${hemanth.id}`).set(as('dr.rohit'));
    expect(r.status).toBe(200);
    expect(r.body.patient).toMatchObject({ name: 'Hemanth', phone: '9876543210', abhaId: '••••••••••1234' });
    expect(r.body.access.type).toBe('treating');
    expect(r.body.meta).toMatchObject({ shardId: hemanth.shardId });
  });

  it('TC-API-11: doctor WITHOUT consent is denied (403) and the denial is audited', async () => {
    const r = await api.get(`/api/patients/${hemanth.id}`).set(as('dr.varun'));
    expect(r.status).toBe(403);
    expect(r.body.details[0]).toMatchObject({ reason: 'NO_ACTIVE_CONSENT', canBreakGlass: true });
    await waitUntil(() => stack.audit.chain().some((e) => e.data.type === 'ACCESS_DENIED' && e.data.actor.id === 'D-VARUN' && e.data.patientId === hemanth.id));
  });

  it('TC-API-12: admin is denied clinical data (least privilege)', async () => {
    expect((await api.get(`/api/patients/${hemanth.id}`).set(as('admin'))).status).toBe(403);
    expect((await api.get('/api/patients').set(as('admin'))).status).toBe(403);
  });

  it('TC-API-13: patient reads own record with full ABHA; cannot read another patient (IDOR)', async () => {
    const own = await api.get(`/api/patients/${hemanth.id}`).set(as('hemanth'));
    expect(own.status).toBe(200);
    expect(own.body.patient.abhaId).toBe('12345678901234');
    const other = await api.post('/api/patients').set(as('dr.rohit')).send(validPatient({ name: 'Allan' }));
    expect((await api.get(`/api/patients/${other.body.id}`).set(as('hemanth'))).status).toBe(403);
    expect((await api.get(`/api/patients/${other.body.id}/access-log`).set(as('hemanth'))).status).toBe(403);
  });

  it('TC-API-14: unknown patient → 404', async () => {
    expect((await api.get('/api/patients/P-NOPE00').set(as('dr.rohit'))).status).toBe(404);
  });

  it('TC-API-15: break-glass requires a reason ≥10 chars, then grants time-limited access', async () => {
    expect((await api.post(`/api/patients/${hemanth.id}/break-glass`).set(as('dr.varun')).send({ reason: 'urgent' })).status).toBe(400);
    const r = await api.post(`/api/patients/${hemanth.id}/break-glass`).set(as('dr.varun')).send({ reason: 'Unconscious in ER, need allergies' });
    expect(r.status).toBe(201);
    expect(new Date(r.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 60000);
    const read = await api.get(`/api/patients/${hemanth.id}`).set(as('dr.varun'));
    expect(read.status).toBe(200);
    expect(read.body.access).toMatchObject({ type: 'breakglass', reason: 'BREAK_GLASS_ACTIVE' });
    await waitUntil(() => stack.audit.chain().some((e) => e.data.type === 'BREAK_GLASS' && e.data.severity === 'HIGH'));
  });

  it('TC-API-16: patient grants and revokes consent; access follows immediately', async () => {
    const before = await api.get(`/api/patients/${hemanth.id}`).set(as('dr.nikhil'));
    expect(before.status).toBe(403);
    expect((await api.post(`/api/patients/${hemanth.id}/consents`).set(as('hemanth')).send({ doctorId: 'D-NIKHIL' })).status).toBe(201);
    expect((await api.get(`/api/patients/${hemanth.id}`).set(as('dr.nikhil'))).status).toBe(200);
    const list = await api.get(`/api/patients/${hemanth.id}/consents`).set(as('hemanth'));
    expect(list.body.consents.map((c) => c.doctorId)).toEqual(expect.arrayContaining(['D-ROHIT', 'D-VARUN', 'D-NIKHIL']));
    expect((await api.delete(`/api/patients/${hemanth.id}/consents/D-NIKHIL`).set(as('hemanth'))).status).toBe(200);
    expect((await api.get(`/api/patients/${hemanth.id}`).set(as('dr.nikhil'))).status).toBe(403); // cache invalidated
  });

  it('TC-API-17: consent for a non-existent doctor → 404; doctors cannot manage consent', async () => {
    expect((await api.post(`/api/patients/${hemanth.id}/consents`).set(as('hemanth')).send({ doctorId: 'D-FAKE' })).status).toBe(404);
    expect((await api.post(`/api/patients/${hemanth.id}/consents`).set(as('dr.rohit')).send({ doctorId: 'D-VARUN' })).status).toBe(403);
  });

  it('TC-API-18: patient sees who accessed their data, backed by a verified ledger', async () => {
    await waitUntil(async () => {
      const r = await api.get(`/api/patients/${hemanth.id}/access-log`).set(as('hemanth'));
      return r.body.entries?.some((e) => e.type === 'BREAK_GLASS');
    });
    const r = await api.get(`/api/patients/${hemanth.id}/access-log`).set(as('hemanth'));
    expect(r.body.ledger.valid).toBe(true);
    const types = new Set(r.body.entries.map((e) => e.type));
    for (const t of ['PATIENT_REGISTERED', 'RECORD_READ', 'ACCESS_DENIED', 'BREAK_GLASS', 'CONSENT_GRANTED', 'CONSENT_REVOKED']) expect(types).toContain(t);
  });
});

describe('Clinical records, caching, encryption & idempotency', () => {
  const note = { type: 'note', title: 'Follow-up', content: 'BP improving on amlodipine.' };

  it('TC-API-19: doctor with access adds a record; it is returned decrypted, newest first', async () => {
    const w = await api.post(`/api/patients/${hemanth.id}/records`).set(as('dr.rohit')).send(note);
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ shardId: hemanth.shardId, duplicate: false });
    const r = await api.get(`/api/patients/${hemanth.id}`).set(as('dr.rohit'));
    expect(r.body.records[0]).toMatchObject({ title: 'Follow-up', content: note.content, author: { id: 'D-ROHIT' } });
  });

  it('TC-API-20: record validation errors → 400; doctor without consent → 403', async () => {
    expect((await api.post(`/api/patients/${hemanth.id}/records`).set(as('dr.rohit')).send({ type: 'vitals', title: 'Bad', heartRate: 999 })).status).toBe(400);
    const other = await api.post('/api/patients').set(as('dr.rohit')).send(validPatient({ name: 'Ashwin' }));
    expect((await api.post(`/api/patients/${other.body.id}/records`).set(as('dr.nikhil')).send(note)).status).toBe(403);
  });

  it('TC-API-21: sensitive fields are stored as AES-GCM ciphertext on EVERY replica', async () => {
    const shard = stack.topology.find((s) => s.id === hemanth.shardId);
    await waitUntil(() => shard.nodes.every((n) => stack.running.get(n.id)?.node.stateMachine.get(`records:${hemanth.id}`)?.value?.length > 0));
    for (const n of shard.nodes) {
      const sm = stack.running.get(n.id).node.stateMachine;
      const p = sm.get(`patient:${hemanth.id}`).value;
      expect(p.phone).toMatch(/^enc:v1:/);
      expect(p.abhaId).toMatch(/^enc:v1:/);
      expect(JSON.stringify(sm.get(`records:${hemanth.id}`).value)).not.toContain('amlodipine');
    }
  });

  it('TC-API-22: second read is a cache HIT; a write invalidates it (cache-aside)', async () => {
    await api.get(`/api/patients/${hemanth.id}`).set(as('dr.rohit'));
    const hit = await api.get(`/api/patients/${hemanth.id}`).set(as('dr.rohit'));
    expect(hit.headers['x-cache']).toBe('HIT');
    await api.post(`/api/patients/${hemanth.id}/records`).set(as('dr.rohit')).send({ ...note, title: 'Invalidate' });
    const miss = await api.get(`/api/patients/${hemanth.id}`).set(as('dr.rohit'));
    expect(miss.headers['x-cache']).toBe('MISS');
    expect(miss.body.records[0].title).toBe('Invalidate');
  });

  it('TC-API-23: retrying with the same Idempotency-Key does not create a duplicate', async () => {
    const send = () => api.post(`/api/patients/${hemanth.id}/records`).set(as('dr.rohit')).set('Idempotency-Key', 'retry-abc').send({ ...note, title: 'Exactly once' });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true, record: { id: first.body.record.id } });
    const r = await api.get(`/api/patients/${hemanth.id}`).set(as('dr.rohit'));
    expect(r.body.records.filter((x) => x.title === 'Exactly once')).toHaveLength(1);
  });
});

describe('Operations API', () => {
  it('TC-API-24: admin sees topology with one leader per shard and the ring distribution', async () => {
    await waitUntil(async () => (await api.get('/api/admin/cluster').set(as('admin'))).body.shards.every((s) => s.leaderId));
    const r = await api.get('/api/admin/cluster').set(as('admin'));
    expect(r.body.shards).toHaveLength(2);
    for (const s of r.body.shards) {
      expect(s.nodes.filter((n) => n.role === 'leader')).toHaveLength(1);
      expect(s.nodes.every((n) => n.up)).toBe(true);
    }
    expect(Object.values(r.body.ring).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(r.body.ringPoints).toHaveLength(300);
  });

  it('TC-API-25: non-admins cannot use operations endpoints', async () => {
    expect((await api.get('/api/admin/cluster').set(as('dr.rohit'))).status).toBe(403);
    expect((await api.post('/api/admin/nodes/a1/kill').set(as('hemanth'))).status).toBe(403);
  });

  it('TC-API-26: probe writes through Raft; ring lookup agrees with the router', async () => {
    const p = await api.post('/api/admin/probe').set(as('admin')).send({ shardId: 'shard-b' });
    expect(p.body).toMatchObject({ ok: true, shardId: 'shard-b' });
    expect((await api.post('/api/admin/probe').set(as('admin')).send({ shardId: 'shard-z' })).status).toBe(404);
    const l = await api.get(`/api/admin/ring/lookup?key=${hemanth.id}`).set(as('admin'));
    expect(l.body.shardId).toBe(hemanth.shardId);
    expect((await api.get('/api/admin/ring/lookup').set(as('admin'))).status).toBe(400);
  });

  it('TC-API-27: raw replica log, metrics, event bus and audit verification are exposed to admins', async () => {
    const log = await api.get('/api/admin/nodes/a1/log?limit=5').set(as('admin'));
    expect(log.body.entries.length).toBeGreaterThan(0);
    const m = await api.get('/api/admin/metrics').set(as('admin'));
    expect(m.body.latency.samples).toBeGreaterThan(0);
    expect(m.body.throughput).toHaveLength(60);
    const bus = await api.get('/api/admin/eventbus').set(as('admin'));
    expect(bus.body.topics.map((t) => t.name)).toEqual(expect.arrayContaining(['ehr.events', 'cluster.events']));
    const v = await api.get('/api/admin/audit/verify').set(as('admin'));
    expect(v.body.valid).toBe(true);
    expect((await api.get('/api/admin/audit?limit=5').set(as('admin'))).body.entries).toHaveLength(5);
  });

  it('TC-API-28: Prometheus endpoint exposes request counters and histograms', async () => {
    const r = await api.get('/metrics');
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.text).toContain('http_requests_total{');
    expect(r.text).toContain('http_request_duration_ms_bucket{');
    expect(r.text).toContain('cache_hit_ratio');
  });

  it('TC-API-29: unknown node / action are rejected', async () => {
    expect((await api.post('/api/admin/nodes/zz9/kill').set(as('admin'))).status).toBe(404);
    expect((await api.post('/api/admin/nodes/a1/explode').set(as('admin'))).status).toBe(400);
    expect((await api.get('/api/does-not-exist').set(as('admin'))).status).toBe(404);
  });

  it('TC-API-30: health endpoint reports readiness and leaders', async () => {
    const r = await api.get('/health');
    expect(r.body).toMatchObject({ ok: true, ready: true });
    expect(r.body.shards.every((s) => s.leaderId)).toBe(true);
  });
});

describe('Real-time notifications (SSE)', () => {
  it('TC-API-31: patient receives a live event when a doctor reads their record', async () => {
    const res = await fetch(`${stack.url}/api/notifications/stream`, { headers: as('hemanth') });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    await new Promise((r) => setTimeout(r, 200));
    await api.get(`/api/patients/${hemanth.id}`).set(as('dr.rohit'));
    const deadline = Date.now() + 8000;
    let found = false;
    while (!found && Date.now() < deadline) {
      const { value } = await reader.read();
      buf += dec.decode(value);
      found = buf.split('\n').some((l) => l.startsWith('data: ') && !l.includes('"replay":true') && l.includes('"RECORD_READ"') && l.includes('D-ROHIT'));
    }
    await reader.cancel();
    expect(found).toBe(true);
  });

  it('TC-API-32: stream rejects missing tokens', async () => {
    const r = await httpJson(`${stack.url}/api/notifications/stream`);
    expect(r.status).toBe(401);
    expect((await httpJson(`${stack.notify.url}/stream`, { headers: { authorization: 'Bearer junk', 'x-service-token': TOKEN } })).status).toBe(401);
  });
});
