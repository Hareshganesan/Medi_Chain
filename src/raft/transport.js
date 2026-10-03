import { httpJson } from '../common/http.js';

const RPC_PATH = { preVote: 'pre-vote', requestVote: 'request-vote', appendEntries: 'append-entries' };

/** Raft RPCs over HTTP between storage-node processes. */
export class HttpTransport {
  constructor({ peers = {}, token, timeoutMs = 800 }) {
    this.peers = peers; // id → base URL
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async send(peerId, type, payload) {
    const url = this.peers[peerId];
    if (!url) throw new Error(`Unknown peer ${peerId}`);
    const r = await httpJson(`${url}/raft/${RPC_PATH[type]}`, {
      method: 'POST',
      body: payload,
      headers: { 'x-service-token': this.token },
      timeoutMs: this.timeoutMs,
    });
    if (r.status !== 200) throw new Error(`RPC ${type} to ${peerId} failed with ${r.status}`);
    return r.data;
  }
}

/**
 * In-memory network for deterministic tests. Supports fault injection:
 * partitions, one-way link cuts and random message loss.
 */
export class MemoryNetwork {
  constructor({ latencyMs = 1, dropRate = 0, random = Math.random } = {}) {
    this.nodes = new Map();
    this.blocked = new Set(); // "from->to"
    this.latencyMs = latencyMs;
    this.dropRate = dropRate;
    this.random = random;
  }

  register(id, node) {
    this.nodes.set(id, node);
  }

  unregister(id) {
    this.nodes.delete(id);
  }

  /** Split the cluster: nodes can only talk inside their own group. */
  partition(...groups) {
    this.heal();
    const groupOf = new Map();
    groups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
    const all = [...new Set([...this.nodes.keys(), ...groupOf.keys()])];
    for (const a of all) for (const b of all) if (a !== b && groupOf.get(a) !== groupOf.get(b)) this.blocked.add(`${a}->${b}`);
  }

  cut(from, to) {
    this.blocked.add(`${from}->${to}`);
  }

  heal() {
    this.blocked.clear();
  }

  transportFor(from) {
    return {
      send: async (to, type, payload) => {
        await new Promise((r) => setTimeout(r, this.latencyMs));
        if (this.blocked.has(`${from}->${to}`) || this.random() < this.dropRate) throw new Error('message dropped');
        const node = this.nodes.get(to);
        if (!node) throw new Error(`node ${to} unreachable`);
        // Deep copy so nodes never share object references, like a real network.
        const res = node.handle(type, structuredClone(payload));
        await new Promise((r) => setTimeout(r, this.latencyMs));
        if (this.blocked.has(`${to}->${from}`)) throw new Error('reply dropped');
        return structuredClone(res);
      },
    };
  }
}
