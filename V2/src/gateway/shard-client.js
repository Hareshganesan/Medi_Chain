import { CircuitBreaker } from '../common/circuit-breaker.js';
import { HashRing } from '../common/consistent-hash.js';
import { httpJson, sleep, backoffDelay } from '../common/http.js';

export class ShardUnavailableError extends Error {
  constructor(shardId, cause) {
    super(`Shard ${shardId} is unavailable: ${cause?.message ?? 'no healthy replica'}`);
    this.code = 'SHARD_UNAVAILABLE';
    this.status = 503;
    this.expose = true;
    this.shardId = shardId;
  }
}

/**
 * Smart client for one Raft group (shard).
 *  - Remembers the current leader; follows NOT_LEADER redirects.
 *  - On leader failure, retries other replicas with exponential backoff until a
 *    new leader is elected → clients see a slower request, not an error.
 *  - One circuit breaker per replica so a dead node is skipped instantly.
 *  - Eventual reads are spread over followers (read replicas).
 */
export class ShardClient {
  constructor({ shardId, nodes, token, timeoutMs = 1500, deadlineMs = 8000, breaker = {} }) {
    this.shardId = shardId;
    this.nodes = nodes; // [{ id, url }]
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.deadlineMs = deadlineMs;
    this.leaderId = null;
    this.rr = 0;
    this.breakers = Object.fromEntries(
      nodes.map((n) => [n.id, new CircuitBreaker({ name: `${shardId}/${n.id}`, failureThreshold: 2, resetTimeout: 2500, ...breaker })]),
    );
    this.stats = { redirects: 0, retries: 0, failovers: 0, requests: 0 };
  }

  node(id) {
    return this.nodes.find((n) => n.id === id);
  }

  healthy() {
    const ok = this.nodes.filter((n) => this.breakers[n.id].canRequest());
    return ok.length ? ok : this.nodes;
  }

  pickForWrite() {
    if (this.leaderId && this.breakers[this.leaderId]?.canRequest()) return this.node(this.leaderId);
    const pool = this.healthy();
    return pool[this.rr++ % pool.length];
  }

  call(node, path, { method = 'GET', body, requestId } = {}) {
    return this.breakers[node.id].exec(() =>
      httpJson(`${node.url}${path}`, {
        method,
        body,
        timeoutMs: this.timeoutMs,
        headers: { 'x-service-token': this.token, ...(requestId ? { 'x-request-id': requestId } : {}) },
      }),
    );
  }

  /** Send to the leader, transparently surviving redirects and fail-overs. */
  async toLeader(path, opts = {}) {
    this.stats.requests++;
    const deadline = Date.now() + this.deadlineMs;
    let attempt = 0;
    let quickRedirects = 0;
    let lastErr;
    while (Date.now() < deadline) {
      const node = this.pickForWrite();
      try {
        const r = await this.call(node, path, opts);
        if (r.status === 421) {
          this.stats.redirects++;
          this.leaderId = r.data?.leaderId ?? null;
          if (this.leaderId && this.leaderId !== node.id && quickRedirects++ < 3) continue; // follow hint immediately
          lastErr = new Error('leader election in progress');
        } else if (r.status === 503 || r.status >= 500) {
          lastErr = new Error(r.data?.message || `replica ${node.id} returned ${r.status}`);
          if (this.leaderId === node.id) this.leaderId = null;
        } else {
          this.leaderId = node.id;
          return { ...r, servedBy: node.id, attempts: attempt + 1 };
        }
      } catch (err) {
        lastErr = err;
        if (this.leaderId === node.id) {
          this.leaderId = null;
          this.stats.failovers++;
        }
      }
      this.stats.retries++;
      await sleep(backoffDelay(attempt++, { baseDelayMs: 80, maxDelayMs: 600 }));
    }
    throw new ShardUnavailableError(this.shardId, lastErr);
  }

  /** Eventual consistency: any live replica may answer — prefer followers to offload the leader. */
  async fromAny(path, opts = {}) {
    this.stats.requests++;
    const pool = this.healthy();
    const followers = pool.filter((n) => n.id !== this.leaderId);
    const k = followers.length ? this.rr++ % followers.length : 0;
    const ordered = [...followers.slice(k), ...followers.slice(0, k), ...pool.filter((n) => n.id === this.leaderId)];
    let lastErr;
    for (const node of ordered) {
      try {
        const r = await this.call(node, path, opts);
        if (r.status === 200) return { ...r, servedBy: node.id, attempts: 1 };
        lastErr = new Error(`replica ${node.id} returned ${r.status}`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new ShardUnavailableError(this.shardId, lastErr);
  }

  command(command, requestId) {
    return this.toLeader('/kv/command', { method: 'POST', body: { command }, requestId });
  }

  get(key, consistency = 'strong', requestId) {
    const path = `/kv/get?key=${encodeURIComponent(key)}&consistency=${consistency}`;
    return consistency === 'strong' ? this.toLeader(path, { requestId }) : this.fromAny(path, { requestId });
  }

  scan(prefix, consistency = 'eventual', requestId) {
    const path = `/kv/scan?prefix=${encodeURIComponent(prefix)}&consistency=${consistency}`;
    return consistency === 'strong' ? this.toLeader(path, { requestId }) : this.fromAny(path, { requestId });
  }

  snapshot() {
    return {
      shardId: this.shardId,
      leaderId: this.leaderId,
      stats: this.stats,
      breakers: Object.values(this.breakers).map((b) => b.snapshot()),
    };
  }
}

/** Maps a patient id to its shard with consistent hashing; all of a patient's data is co-located. */
export class ShardRouter {
  constructor({ shards, token, clientOptions = {} }) {
    this.ring = new HashRing(shards.map((s) => s.id));
    this.clients = new Map(shards.map((s) => [s.id, new ShardClient({ shardId: s.id, nodes: s.nodes, token, ...clientOptions })]));
  }

  shardIdFor(patientId) {
    return this.ring.getNode(patientId);
  }

  forPatient(patientId) {
    return this.clients.get(this.shardIdFor(patientId));
  }

  all() {
    return [...this.clients.values()];
  }

  findNode(nodeId) {
    for (const c of this.clients.values()) {
      const n = c.node(nodeId);
      if (n) return { shard: c, node: n };
    }
    return null;
  }
}
