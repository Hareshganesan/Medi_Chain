/**
 * Token-bucket rate limiter, one bucket per key (user id or IP).
 * `capacity` = allowed burst, `refillPerSec` = sustained rate.
 */
export class TokenBucketLimiter {
  constructor({ capacity = 20, refillPerSec = 10, now = Date.now, maxKeys = 10000 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  take(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      b = { tokens: this.capacity, last: t };
      this.buckets.set(key, b);
    }
    const elapsed = Math.max(0, t - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.last = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    const retryAfterMs = Math.ceil(((cost - b.tokens) / this.refillPerSec) * 1000);
    return { allowed: false, remaining: 0, retryAfterMs };
  }
}

/** Express middleware factory. */
export function rateLimit(limiter, keyFn, onLimited) {
  return (req, res, next) => {
    const r = limiter.take(keyFn(req));
    res.setHeader('X-RateLimit-Remaining', r.remaining);
    if (r.allowed) return next();
    onLimited?.(req);
    res.setHeader('Retry-After', Math.ceil(r.retryAfterMs / 1000));
    res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests', retryAfterMs: r.retryAfterMs });
  };
}
