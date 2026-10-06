/**
 * LRU cache with per-entry TTL — stands in for Redis in the cache-aside pattern.
 * A JS Map keeps insertion order, so re-inserting on access gives O(1) LRU.
 */
export class LRUCache {
  constructor({ max = 500, ttlMs = 30000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  get(key) {
    const e = this.map.get(key);
    if (!e || e.expires <= this.now()) {
      if (e) this.map.delete(key);
      this.stats.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    this.stats.hits++;
    return e.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
      this.stats.evictions++;
    }
  }

  delete(key) {
    return this.map.delete(key);
  }

  /** Invalidate every key that starts with `prefix`. */
  deletePrefix(prefix) {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }

  get size() {
    return this.map.size;
  }

  snapshot() {
    const total = this.stats.hits + this.stats.misses;
    return { size: this.map.size, max: this.max, ...this.stats, hitRatio: total ? this.stats.hits / total : 0 };
  }
}
