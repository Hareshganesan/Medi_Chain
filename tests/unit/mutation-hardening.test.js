import { describe, it, expect, vi } from 'vitest';
import { HashRing } from '../../src/common/consistent-hash.js';
import { CircuitBreaker, STATE } from '../../src/common/circuit-breaker.js';
import { TokenBucketLimiter, rateLimit } from '../../src/common/rate-limiter.js';
import { LRUCache } from '../../src/common/lru-cache.js';
import { canonical, GENESIS_HASH } from '../../src/common/hash-chain.js';
import { ACTIONS } from '../../src/common/rbac.js';
import { KVStateMachine } from '../../src/raft/kv-state-machine.js';

/**
 * Tests added AFTER mutation testing (Stryker) revealed mutants that survived the
 * original suite despite ~98% line coverage. Each test names the gap it closes.
 */
describe('Mutation-driven hardening', () => {
  it('TC-MUT-01: removeNode really removes the node — no key maps to it afterwards', () => {
    // Survivor: `removeNode` body deleted. TC-HASH-09 passed trivially because keys kept their old owner.
    const ring = new HashRing(['a', 'b', 'c'], { virtualNodes: 20 });
    ring.removeNode('b');
    expect(ring.ring.some((v) => v.node === 'b')).toBe(false);
    expect(ring.ring).toHaveLength(40);
    for (let i = 0; i < 500; i++) expect(ring.getNode(`k${i}`)).not.toBe('b');
  });

  it('TC-MUT-02 (BVA): a key hashing EXACTLY onto a vnode belongs to that vnode', () => {
    // Survivors: `<` → `<=` in the binary search and `>` → `>=` in the wrap-around check.
    const ring = new HashRing(['a', 'b', 'c'], { virtualNodes: 30 });
    for (const node of ['a', 'b', 'c']) for (let i = 0; i < 30; i++) expect(ring.getNode(`${node}#${i}`)).toBe(node);
  });

  it('TC-MUT-03: distribution of an empty ring is an empty object', () => {
    expect(new HashRing([]).distribution()).toEqual({});
  });

  it('TC-MUT-04: breaker timing uses elapsed time (clock not starting at 0)', async () => {
    // Survivor: `now - openedAt` → `now + openedAt` (invisible when the clock starts at 0).
    const clock = { t: 1_000_000 };
    const cb = new CircuitBreaker({ name: 'db', failureThreshold: 1, resetTimeout: 500, now: () => clock.t });
    await cb.exec(() => Promise.reject(new Error('x'))).catch(() => {});
    clock.t += 499;
    expect(cb.canRequest()).toBe(false);
    clock.t += 1;
    expect(cb.canRequest()).toBe(true);
  });

  it('TC-MUT-05: one failed HALF_OPEN trial re-opens even with a high threshold', async () => {
    const clock = { t: 0 };
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 100, now: () => clock.t });
    for (let i = 0; i < 3; i++) await cb.exec(() => Promise.reject(new Error('x'))).catch(() => {});
    clock.t = 100;
    expect(cb.snapshot().state).toBe(STATE.HALF_OPEN); // snapshot refreshes the state
    await cb.exec(() => Promise.reject(new Error('x'))).catch(() => {});
    expect(cb.state).toBe(STATE.OPEN);
  });

  it('TC-MUT-06: breaker error message names the circuit; state names are distinct', async () => {
    const cb = new CircuitBreaker({ name: 'shard-a/a1', failureThreshold: 1 });
    await cb.exec(() => Promise.reject(new Error('x'))).catch(() => {});
    await expect(cb.exec(async () => 1)).rejects.toThrow('Circuit "shard-a/a1" is OPEN');
    expect(new Set(Object.values(STATE)).size).toBe(3);
    expect(Object.values(STATE)).toEqual(['CLOSED', 'OPEN', 'HALF_OPEN']);
    expect(new CircuitBreaker().name).toBe('breaker');
  });

  it('TC-MUT-07: rate limiter refill uses elapsed time × rate (clock not at 0)', () => {
    const clock = { t: 5_000_000 };
    const rl = new TokenBucketLimiter({ capacity: 10, refillPerSec: 4, now: () => clock.t });
    for (let i = 0; i < 10; i++) rl.take('u');
    clock.t += 500; // 0.5 s × 4/s = 2 tokens
    expect(rl.take('u')).toMatchObject({ allowed: true, remaining: 1 });
    expect(rl.take('u').allowed).toBe(true);
    const denied = rl.take('u');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(250); // 1 token / 4 per s
  });

  it('TC-MUT-08: retryAfter accounts for partially refilled tokens and cost', () => {
    const clock = { t: 1_000 };
    const rl = new TokenBucketLimiter({ capacity: 2, refillPerSec: 1, now: () => clock.t });
    rl.take('u', 2);
    clock.t += 500; // 0.5 token available
    expect(rl.take('u', 2).retryAfterMs).toBe(1500); // needs 1.5 more tokens
  });

  it('TC-MUT-09: 429 response body and headers are complete; hook optional', () => {
    const rl = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 });
    const mw = rateLimit(rl, () => 'k'); // no onLimited hook — must not throw
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    const next = vi.fn();
    mw({}, res, next);
    expect(res.headers['X-RateLimit-Remaining']).toBe(0);
    mw({}, res, next);
    expect(res.body).toEqual({ error: 'RATE_LIMITED', message: 'Too many requests', retryAfterMs: 1000 });
  });

  it('TC-MUT-10 (BVA): cache entry expires exactly at its TTL and is removed from memory', () => {
    const clock = { t: 0 };
    const c = new LRUCache({ ttlMs: 100, now: () => clock.t });
    c.set('k', 'v');
    clock.t = 100;
    expect(c.get('k')).toBeUndefined();
    expect(c.size).toBe(0);
    expect(c.get('never-set')).toBeUndefined(); // miss on a missing key must not throw
  });

  it('TC-MUT-11: re-setting an existing key refreshes its recency', () => {
    const c = new LRUCache({ max: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 3); // a becomes most recent
    c.set('c', 4);
    expect(c.get('a')).toBe(3);
    expect(c.get('b')).toBeUndefined();
  });

  it('TC-MUT-12: canonical JSON has an exact, stable format; genesis is 64 zeros', () => {
    expect(canonical({ b: [1, 'x', { d: 2, c: 1 }], a: null })).toBe('{"a":null,"b":[1,"x",{"c":1,"d":2}]}');
    expect(canonical([])).toBe('[]');
    expect(GENESIS_HASH).toMatch(/^0{64}$/);
  });

  it('TC-MUT-13: RBAC action identifiers are unique and namespaced', () => {
    const values = Object.values(ACTIONS);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[a-z-]+:[a-z-]+$/);
  });

  it('TC-MUT-14: state machine dedup returns the original result and does not re-apply', () => {
    const sm = new KVStateMachine();
    const first = sm.apply({ type: 'append', key: 'l', value: { id: 'x1' }, requestId: 'r1' }, 1);
    const again = sm.apply({ type: 'append', key: 'l', value: { id: 'x2' }, requestId: 'r1' }, 2);
    expect(again).toEqual({ ...first, duplicate: true });
    expect(sm.get('l').value).toEqual([{ id: 'x1' }]);
    expect(sm.appliedCount).toBe(1);
    sm.apply({ type: 'noop' }, 3);
    sm.apply({ type: 'noop' }, 4);
    expect(sm.applied.size).toBe(1); // commands without requestId are not remembered
    expect(sm.apply({ type: 'noop' }, 5)).toEqual({ ok: true });
  });

  it('TC-MUT-15: mapSet on a non-object value starts a fresh map; edge cases are safe', () => {
    const sm = new KVStateMachine();
    sm.apply({ type: 'put', key: 'm', value: 'scalar' }, 1);
    sm.apply({ type: 'mapSet', key: 'm', field: 'a', value: 1 }, 2);
    expect(sm.get('m').value).toEqual({ a: 1 });
    sm.apply({ type: 'mapSet', key: 'n', field: 'a', value: 1 }, 3);
    sm.apply({ type: 'mapSet', key: 'n', field: 'b', value: 2 }, 4);
    expect(sm.get('n').value).toEqual({ a: 1, b: 2 });
    expect(sm.apply({ type: 'mapDelete', key: 'missing', field: 'x' }, 5).ok).toBe(true);
    expect(sm.apply({ type: 'append', key: 'l2', value: 'plain' }, 6).itemId).toBeNull();
    expect(sm.apply({ type: 'put', key: 'new', value: 1, expectedVersion: 5 }, 7)).toMatchObject({ currentVersion: 0 });
    expect(sm.apply({ type: 'delete', key: 'nope' }, 8)).toMatchObject({ deleted: false });
    expect(sm.scan().length).toBe(sm.size());
  });
});
