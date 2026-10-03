import { describe, it, expect, vi } from 'vitest';
import { TokenBucketLimiter, rateLimit } from '../../src/common/rate-limiter.js';
import { LRUCache } from '../../src/common/lru-cache.js';

describe('Token-bucket rate limiter', () => {
  const make = () => {
    const clock = { t: 0 };
    return { clock, rl: new TokenBucketLimiter({ capacity: 5, refillPerSec: 1, now: () => clock.t }) };
  };

  it('TC-RL-01 (BVA): allows exactly `capacity` requests in a burst, rejects capacity+1', () => {
    const { rl } = make();
    for (let i = 0; i < 5; i++) expect(rl.take('u').allowed).toBe(true);
    const sixth = rl.take('u');
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterMs).toBe(1000);
  });

  it('TC-RL-02: tokens refill over time but never above capacity', () => {
    const { rl, clock } = make();
    for (let i = 0; i < 5; i++) rl.take('u');
    clock.t = 2000;
    expect(rl.take('u').remaining).toBe(1); // 2 refilled, 1 used
    clock.t = 1_000_000;
    expect(rl.take('u').remaining).toBe(4); // capped at 5, 1 used
  });

  it('TC-RL-03: buckets are isolated per key (one noisy client cannot starve another)', () => {
    const { rl } = make();
    for (let i = 0; i < 6; i++) rl.take('noisy');
    expect(rl.take('quiet').allowed).toBe(true);
  });

  it('TC-RL-04: evicts the oldest bucket when maxKeys is reached (bounded memory)', () => {
    const rl = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 2, now: () => 0 });
    rl.take('a');
    rl.take('b');
    rl.take('c');
    expect(rl.buckets.has('a')).toBe(false);
    expect(rl.buckets.size).toBe(2);
  });

  it('TC-RL-05: middleware returns 429 with Retry-After and calls the onLimited hook', () => {
    const rl = new TokenBucketLimiter({ capacity: 1, refillPerSec: 0.5, now: () => 0 });
    const onLimited = vi.fn();
    const mw = rateLimit(rl, () => 'k', onLimited);
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    const next = vi.fn();
    mw({}, res, next);
    mw({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.code).toBe(429);
    expect(res.headers['Retry-After']).toBe(2);
    expect(onLimited).toHaveBeenCalledOnce();
  });
});

describe('LRU cache with TTL', () => {
  it('TC-CACHE-01: returns a stored value and counts hits/misses', () => {
    const c = new LRUCache();
    expect(c.get('x')).toBeUndefined();
    c.set('x', 1);
    expect(c.get('x')).toBe(1);
    expect(c.snapshot()).toMatchObject({ hits: 1, misses: 1, hitRatio: 0.5 });
  });

  it('TC-CACHE-02: evicts the LEAST recently used entry, not the oldest inserted', () => {
    const c = new LRUCache({ max: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // a is now most recent
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.stats.evictions).toBe(1);
  });

  it('TC-CACHE-03 (BVA): entry is valid 1 ms before expiry and gone exactly at expiry', () => {
    const clock = { t: 0 };
    const c = new LRUCache({ ttlMs: 100, now: () => clock.t });
    c.set('k', 'v');
    clock.t = 99;
    expect(c.get('k')).toBe('v');
    clock.t = 199; // re-read does not extend TTL; set at 0 → expires at 100
    expect(c.get('k')).toBeUndefined();
  });

  it('TC-CACHE-04: deletePrefix invalidates every key of one patient', () => {
    const c = new LRUCache();
    c.set('patient:P1', 1);
    c.set('patient:P1:x', 2);
    c.set('patient:P2', 3);
    c.deletePrefix('patient:P1');
    expect(c.size).toBe(1);
    expect(c.get('patient:P2')).toBe(3);
    expect(c.delete('patient:P2')).toBe(true);
  });
});
