/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

const labelKey = (labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`)
    .join(',');

/**
 * In-process metrics registry: counters, latency histograms and a
 * per-second throughput timeline. Exposed in Prometheus text format at /metrics.
 */
export class Metrics {
  constructor({ window = 2000, now = Date.now } = {}) {
    this.counters = new Map();
    this.histograms = new Map();
    this.samples = [];
    this.window = window;
    this.now = now;
    this.timeline = new Map(); // epochSecond → { requests, errors }
  }

  inc(name, labels = {}, by = 1) {
    const key = `${name}{${labelKey(labels)}}`;
    this.counters.set(key, (this.counters.get(key) || 0) + by);
  }

  observe(name, valueMs, labels = {}) {
    const key = `${name}{${labelKey(labels)}}`;
    let h = this.histograms.get(key);
    if (!h) {
      h = { name, labels, buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.histograms.set(key, h);
    }
    BUCKETS.forEach((b, i) => {
      if (valueMs <= b) h.buckets[i]++;
    });
    h.sum += valueMs;
    h.count++;
    this.samples.push(valueMs);
    if (this.samples.length > this.window) this.samples.shift();
  }

  /** Record one finished HTTP request (used by the gateway middleware). */
  recordRequest(route, status, ms) {
    this.inc('http_requests_total', { route, status });
    this.observe('http_request_duration_ms', ms, { route });
    const sec = Math.floor(this.now() / 1000);
    const slot = this.timeline.get(sec) || { requests: 0, errors: 0 };
    slot.requests++;
    if (status >= 500) slot.errors++;
    this.timeline.set(sec, slot);
    for (const k of this.timeline.keys()) if (k < sec - 120) this.timeline.delete(k);
  }

  latency() {
    const s = [...this.samples].sort((a, b) => a - b);
    return { p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), samples: s.length };
  }

  /** Last `seconds` seconds of throughput, oldest first, gaps filled with zeros. */
  throughput(seconds = 60) {
    const nowSec = Math.floor(this.now() / 1000);
    const out = [];
    for (let s = nowSec - seconds + 1; s <= nowSec; s++) {
      const slot = this.timeline.get(s) || { requests: 0, errors: 0 };
      out.push({ t: s, ...slot });
    }
    return out;
  }

  counterTotal(name) {
    let total = 0;
    for (const [k, v] of this.counters) if (k.startsWith(name + '{')) total += v;
    return total;
  }

  toPrometheus() {
    const lines = [];
    const seen = new Set();
    for (const [key, v] of this.counters) {
      const name = key.slice(0, key.indexOf('{'));
      if (!seen.has(name)) lines.push(`# TYPE ${name} counter`), seen.add(name);
      lines.push(`${key} ${v}`);
    }
    for (const h of this.histograms.values()) {
      if (!seen.has(h.name)) lines.push(`# TYPE ${h.name} histogram`), seen.add(h.name);
      const base = labelKey(h.labels);
      const sep = base ? ',' : '';
      BUCKETS.forEach((b, i) => lines.push(`${h.name}_bucket{${base}${sep}le="${b}"} ${h.buckets[i]}`));
      lines.push(`${h.name}_bucket{${base}${sep}le="+Inf"} ${h.count}`);
      lines.push(`${h.name}_sum{${base}} ${h.sum}`);
      lines.push(`${h.name}_count{${base}} ${h.count}`);
    }
    return lines.join('\n') + '\n';
  }
}
