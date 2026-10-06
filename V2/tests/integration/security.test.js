import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { startStack, validPatient } from '../helpers/stack.js';

/**
 * Security testing aligned with the OWASP API Security Top 10:
 * API1 broken object-level authorisation, API2 broken authentication,
 * API4 unrestricted resource consumption, API8 security misconfiguration, injection.
 */
let stack;
let api;
let doctor;

beforeAll(async () => {
  stack = await startStack({
    gatewayOptions: {
      rateLimitOptions: { capacity: 15, refillPerSec: 0.001 },
      loginRateLimitOptions: { capacity: 5, refillPerSec: 0.001 },
    },
  });
  api = request(stack.url);
  doctor = await stack.login('dr.rohit', 'Doctor@123');
});
afterAll(async () => stack?.stop());

describe('Security (OWASP API Top 10)', () => {
  it('TC-SEC-01 [API8]: security headers are set on every response', async () => {
    const r = await api.get('/');
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('TC-SEC-02 [Injection]: script payloads are rejected by validation, never stored', async () => {
    const r = await api.post('/api/patients').set('Authorization', `Bearer ${doctor}`).send(validPatient({ name: '<img src=x onerror=alert(1)>' }));
    expect(r.status).toBe(400);
  });

  it('TC-SEC-03 [Injection]: NoSQL-style operator objects and prototype pollution are rejected', async () => {
    const r1 = await api.post('/api/auth/login').set('X-Forwarded-For', '10.0.0.1').send({ username: { $ne: null }, password: { $ne: null } });
    expect(r1.status).toBe(400);
    const r2 = await api
      .post('/api/patients')
      .set('Authorization', `Bearer ${doctor}`)
      .set('content-type', 'application/json')
      .send('{"name":"Ganesan","dob":"1990-01-01","gender":"male","bloodGroup":"A+","phone":"9876543210","__proto__":{"role":"admin"}}');
    expect(r2.status).toBe(201);
    expect({}.role).toBeUndefined();
  });

  it('TC-SEC-04 [API4]: malformed JSON → 400 and oversized bodies → 413', async () => {
    const bad = await api.post('/api/patients').set('Authorization', `Bearer ${doctor}`).set('content-type', 'application/json').send('{"name":');
    expect(bad.status).toBe(400);
    const huge = await api.post('/api/patients').set('Authorization', `Bearer ${doctor}`).send({ name: 'x'.repeat(300 * 1024) });
    expect(huge.status).toBe(413);
  });

  it('TC-SEC-05 [API1]: path traversal in ids cannot reach other keys', async () => {
    const r = await api.get(`/api/patients/${encodeURIComponent('../consent:P-1')}`).set('Authorization', `Bearer ${doctor}`);
    expect(r.status).toBe(404);
  });

  it('TC-SEC-06 [API2]: login is rate-limited per client IP (brute-force protection)', async () => {
    const ip = { 'X-Forwarded-For': '203.0.113.7' };
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await api.post('/api/auth/login').set(ip).send({ username: 'dr.varun', password: `guess${i}` })).status);
    expect(codes.slice(0, 5).every((c) => c === 401 || c === 423)).toBe(true);
    expect(codes[5]).toBe(429);
    // another client is unaffected
    expect((await api.post('/api/auth/login').set('X-Forwarded-For', '198.51.100.9').send({ username: 'dr.rohit', password: 'Doctor@123' })).status).toBe(200);
  });

  it('TC-SEC-07 [API4]: authenticated API calls are rate-limited per user with Retry-After', async () => {
    const t = await stack.login('dr.nikhil', 'Doctor@123');
    let limited;
    for (let i = 0; i < 20 && !limited; i++) {
      const r = await api.get('/api/auth/me').set('Authorization', `Bearer ${t}`);
      if (r.status === 429) limited = r;
    }
    expect(limited).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.error).toBe('RATE_LIMITED');
  });

  it('TC-SEC-08: internal services refuse direct calls without the service token (zero trust)', async () => {
    const node = stack.topology[0].nodes[0];
    expect((await request(node.url).get('/kv/scan?prefix=patient:')).status).toBe(401);
    expect((await request(stack.audit.url).get('/audit')).status).toBe(401);
    expect((await request(stack.bus.url).get('/topics')).status).toBe(401);
    expect((await request(stack.auth.url).get('/internal/users')).status).toBe(401);
  });

  it('TC-SEC-09: error responses never leak stack traces', async () => {
    const r = await api.get('/api/patients/%E0%A4%A').set('Authorization', `Bearer ${doctor}`);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.js:\d+/);
  });
});
