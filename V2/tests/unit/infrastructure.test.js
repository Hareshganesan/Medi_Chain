import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backoffDelay, retry } from '../../src/common/http.js';
import { Metrics, percentile } from '../../src/common/metrics.js';
import { KVStateMachine } from '../../src/raft/kv-state-machine.js';
import { FileStorage, MemoryStorage } from '../../src/raft/storage.js';
import { MemoryNetwork } from '../../src/raft/transport.js';
import { audienceFor } from '../../src/notify/notify-service.js';
import { ageFrom } from '../../src/gateway/ehr-repository.js';

describe('Retry with exponential backoff', () => {
  it('TC-RETRY-01: delays grow exponentially and are capped (no jitter)', () => {
    const d = [0, 1, 2, 3, 4, 5].map((a) => backoffDelay(a, { baseDelayMs: 100, maxDelayMs: 1000, jitter: false }));
    expect(d).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it('TC-RETRY-02: full jitter stays within [0, ceiling)', () => {
    expect(backoffDelay(3, { baseDelayMs: 100, random: () => 0 })).toBe(0);
    expect(backoffDelay(3, { baseDelayMs: 100, random: () => 0.999 })).toBe(799);
  });

  it('TC-RETRY-03: retries until success', async () => {
    let n = 0;
    const sleepFn = vi.fn(async () => {});
    const result = await retry(async () => (++n < 3 ? Promise.reject(new Error('flaky')) : 'ok'), { retries: 5, sleepFn });
    expect(result).toBe('ok');
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it('TC-RETRY-04: gives up after `retries` and rethrows the last error', async () => {
    const fn = vi.fn(async () => Promise.reject(new Error('down')));
    await expect(retry(fn, { retries: 2, sleepFn: async () => {} })).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('TC-RETRY-05: does not retry non-retryable errors', async () => {
    const fn = vi.fn(async () => Promise.reject(Object.assign(new Error('bad request'), { status: 400 })));
    await expect(retry(fn, { retries: 5, shouldRetry: (e) => e.status >= 500, sleepFn: async () => {} })).rejects.toThrow();
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('Metrics', () => {
  it('TC-MET-01: nearest-rank percentiles', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 99)).toBe(7);
  });

  it('TC-MET-02: exports valid Prometheus text format with histogram buckets', () => {
    const m = new Metrics();
    m.recordRequest('/api/x', 200, 12);
    m.recordRequest('/api/x', 503, 700);
    const text = m.toPrometheus();
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toContain('http_requests_total{route="/api/x",status="200"} 1');
    expect(text).toContain('http_request_duration_ms_bucket{route="/api/x",le="25"} 1');
    expect(text).toContain('http_request_duration_ms_bucket{route="/api/x",le="+Inf"} 2');
    expect(m.counterTotal('http_requests_total')).toBe(2);
  });

  it('TC-MET-03: throughput timeline fills gaps with zeros and counts 5xx as errors', () => {
    const clock = { t: 10_000 };
    const m = new Metrics({ now: () => clock.t });
    m.recordRequest('r', 500, 1);
    clock.t = 12_000;
    m.recordRequest('r', 200, 1);
    const tl = m.throughput(3);
    expect(tl.map((x) => x.requests)).toEqual([1, 0, 1]);
    expect(tl[0].errors).toBe(1);
  });
});

describe('Replicated KV state machine', () => {
  it('TC-SM-01: put / get / version increments', () => {
    const sm = new KVStateMachine();
    sm.apply({ type: 'put', key: 'k', value: 1, ts: 't1' }, 1);
    const r = sm.apply({ type: 'put', key: 'k', value: 2, ts: 't2' }, 2);
    expect(r.version).toBe(2);
    expect(sm.get('k')).toMatchObject({ value: 2, version: 2, updatedAt: 't2', index: 2 });
  });

  it('TC-SM-02: optimistic concurrency — stale expectedVersion is rejected', () => {
    const sm = new KVStateMachine();
    expect(sm.apply({ type: 'put', key: 'k', value: 'a', expectedVersion: 0 }, 1).ok).toBe(true);
    expect(sm.apply({ type: 'put', key: 'k', value: 'b', expectedVersion: 0 }, 2)).toMatchObject({ ok: false, error: 'VERSION_CONFLICT', currentVersion: 1 });
  });

  it('TC-SM-03: append, mapSet, mapDelete, delete, scan', () => {
    const sm = new KVStateMachine();
    sm.apply({ type: 'append', key: 'list', value: { id: 'a' } }, 1);
    expect(sm.apply({ type: 'append', key: 'list', value: { id: 'b' } }, 2)).toMatchObject({ itemId: 'b', length: 2 });
    sm.apply({ type: 'mapSet', key: 'm', field: 'x', value: 1 }, 3);
    sm.apply({ type: 'mapSet', key: 'm', field: 'y', value: 2 }, 4);
    sm.apply({ type: 'mapDelete', key: 'm', field: 'x' }, 5);
    expect(sm.get('m').value).toEqual({ y: 2 });
    expect(sm.scan('l').map((e) => e.key)).toEqual(['list']);
    expect(sm.apply({ type: 'delete', key: 'm' }, 6)).toMatchObject({ deleted: true });
    expect(sm.get('m')).toBeNull();
    expect(sm.size()).toBe(1);
  });

  it('TC-SM-04: determinism — two replicas applying the same log end identical', () => {
    const log = [
      { type: 'put', key: 'a', value: 1, ts: 'x' },
      { type: 'append', key: 'l', value: 2, ts: 'y' },
      { type: 'mapSet', key: 'm', field: 'f', value: 3, ts: 'z' },
    ];
    const [r1, r2] = [new KVStateMachine(), new KVStateMachine()];
    log.forEach((c, i) => (r1.apply(c, i + 1), r2.apply(structuredClone(c), i + 1)));
    expect(JSON.stringify(r1.scan())).toBe(JSON.stringify(r2.scan()));
  });

  it('TC-SM-05: unknown commands throw; dedup window is bounded', () => {
    const sm = new KVStateMachine({ dedupWindow: 2 });
    expect(() => sm.apply({ type: 'drop-table' }, 1)).toThrow(/Unknown command/);
    for (const id of ['r1', 'r2', 'r3']) sm.apply({ type: 'noop', requestId: id }, 1);
    expect(sm.applied.has('r1')).toBe(false);
    expect(sm.applied.size).toBe(2);
  });
});

describe('Durable storage (write-ahead log)', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
    dirs.push(d);
    return d;
  };

  it('TC-WAL-01: persists meta and log entries across instances', () => {
    const dir = tmp();
    const s = new FileStorage(dir);
    s.saveMeta({ term: 3, votedFor: 'n2' });
    s.append([{ index: 1, term: 1, command: { type: 'noop' } }]);
    s.append([{ index: 2, term: 3, command: { type: 'put', key: 'k', value: 'v' } }]);
    expect(new FileStorage(dir).load()).toMatchObject({ term: 3, votedFor: 'n2', log: [{ index: 1 }, { index: 2 }] });
  });

  it('TC-WAL-02: a torn (half-written) final line after a crash is discarded', () => {
    const dir = tmp();
    const s = new FileStorage(dir);
    s.append([{ index: 1, term: 1, command: {} }]);
    fs.appendFileSync(path.join(dir, 'wal.log'), '{"index":2,"te');
    expect(new FileStorage(dir).load().log).toHaveLength(1);
  });

  it('TC-WAL-03: rewrite() truncates the log (used for conflict resolution)', () => {
    const dir = tmp();
    const s = new FileStorage(dir);
    s.append([1, 2, 3].map((i) => ({ index: i, term: 1, command: {} })));
    s.rewrite([{ index: 1, term: 1, command: {} }]);
    expect(new FileStorage(dir).load().log).toHaveLength(1);
    s.rewrite([]);
    expect(new FileStorage(dir).load()).toMatchObject({ term: 0, votedFor: null, log: [] });
  });

  it('TC-WAL-04: MemoryStorage copies entries (no shared references)', () => {
    const m = new MemoryStorage();
    const e = { index: 1, term: 1, command: { v: 1 } };
    m.append([e]);
    e.term = 99;
    expect(m.load().log[0].term).toBe(1);
  });
});

describe('Memory network fault injection', () => {
  it('TC-NET-01: partitions block traffic in both directions and heal restores it', async () => {
    const net = new MemoryNetwork({ latencyMs: 0 });
    net.register('b', { handle: () => ({ pong: true }) });
    const send = net.transportFor('a').send;
    await expect(send('b', 'x', {})).resolves.toEqual({ pong: true });
    net.partition(['a'], ['b']);
    await expect(send('b', 'x', {})).rejects.toThrow(/dropped/);
    net.heal();
    net.cut('b', 'a'); // one-way: request arrives, reply is lost
    await expect(send('b', 'x', {})).rejects.toThrow(/reply dropped/);
    await expect(send('zzz', 'x', {})).rejects.toThrow(/unreachable/);
  });
});

describe('Notification routing (who sees which event)', () => {
  const ev = { type: 'BREAK_GLASS', patientId: 'P1', actor: { id: 'D-1' } };
  it.each([
    ['admin sees everything', { role: 'admin' }, { ...ev, topic: 'cluster.events' }, true],
    ['patient sees break-glass on own record', { role: 'patient', sub: 'U-P1', patientId: 'P1' }, ev, true],
    ['patient does not see other patients', { role: 'patient', sub: 'U-P2', patientId: 'P2' }, ev, false],
    ['patient not notified of own actions', { role: 'patient', sub: 'D-1', patientId: 'P1' }, ev, false],
    ['patient does not see cluster events', { role: 'patient', patientId: 'P1' }, { ...ev, topic: 'cluster.events' }, false],
    ['doctor sees consent granted to them', { role: 'doctor', sub: 'D-9' }, { type: 'CONSENT_GRANTED', details: { doctorId: 'D-9' } }, true],
    ['doctor does not see consent for others', { role: 'doctor', sub: 'D-9' }, { type: 'CONSENT_GRANTED', details: { doctorId: 'D-1' } }, false],
    ['unknown role sees nothing', { role: 'x' }, ev, false],
  ])('TC-NOTIFY %s', (_, user, event, expected) => expect(audienceFor(event, user)).toBe(expected));
});

describe('Age calculation', () => {
  it('TC-AGE-01 (BVA): birthday today vs tomorrow', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(ageFrom('2000-06-15', now)).toBe(26);
    expect(ageFrom('2000-06-16', now)).toBe(25);
    expect(ageFrom('2000-07-01', now)).toBe(25);
  });
});
