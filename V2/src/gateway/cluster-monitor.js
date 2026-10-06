import { httpJson } from '../common/http.js';

/**
 * Heartbeat-based failure detector + service discovery.
 * Polls every replica's /status, keeps a live topology view for the dashboard,
 * feeds leader hints to the shard clients, and emits cluster events
 * (NODE_DOWN / NODE_UP / LEADER_ELECTED) onto the event bus.
 */
export class ClusterMonitor {
  constructor({ router, publisher, intervalMs = 1000, timeoutMs = 600 }) {
    this.router = router;
    this.publisher = publisher;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.view = new Map(); // nodeId → { up, status, lastSeen }
    this.leaders = new Map(); // shardId → { leaderId, term }
    this.events = [];
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  emit(type, details) {
    const event = this.publisher?.publish('cluster.events', { type, ...details }) ?? { type, ts: new Date().toISOString(), ...details };
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
  }

  async tick() {
    await Promise.all(
      this.router.all().map(async (client) => {
        const statuses = await Promise.all(
          client.nodes.map(async (n) => {
            try {
              const r = await httpJson(`${n.url}/status`, { timeoutMs: this.timeoutMs });
              return { node: n, up: r.ok, status: r.data };
            } catch {
              return { node: n, up: false, status: null };
            }
          }),
        );
        for (const s of statuses) {
          const prev = this.view.get(s.node.id);
          if (prev && prev.up !== s.up) this.emit(s.up ? 'NODE_UP' : 'NODE_DOWN', { shardId: client.shardId, nodeId: s.node.id });
          this.view.set(s.node.id, { up: s.up, status: s.status ?? prev?.status ?? null, lastSeen: s.up ? Date.now() : prev?.lastSeen });
        }
        // The legitimate leader is the reachable, non-isolated leader with the highest term.
        const leader = statuses
          .filter((s) => s.up && s.status?.role === 'leader' && !s.status.isolated)
          .sort((a, b) => b.status.term - a.status.term)[0];
        const prev = this.leaders.get(client.shardId);
        if (leader) {
          client.leaderId = leader.node.id;
          if (!prev || prev.leaderId !== leader.node.id || prev.term !== leader.status.term) {
            this.leaders.set(client.shardId, { leaderId: leader.node.id, term: leader.status.term, since: Date.now() });
            this.emit('LEADER_ELECTED', { shardId: client.shardId, nodeId: leader.node.id, term: leader.status.term });
          }
        } else if (prev?.leaderId) {
          this.leaders.set(client.shardId, { leaderId: null, term: prev.term, since: Date.now() });
          this.emit('NO_LEADER', { shardId: client.shardId, lastTerm: prev.term });
        }
      }),
    );
  }

  topology() {
    return this.router.all().map((client) => ({
      id: client.shardId,
      leaderId: this.leaders.get(client.shardId)?.leaderId ?? null,
      term: this.leaders.get(client.shardId)?.term ?? 0,
      nodes: client.nodes.map((n) => {
        const v = this.view.get(n.id);
        return { ...(v?.status ?? {}), id: n.id, url: n.url, up: v?.up ?? false, lastSeen: v?.lastSeen ?? null };
      }),
    }));
  }

  allShardsHaveLeader() {
    return this.router.all().every((c) => this.leaders.get(c.shardId)?.leaderId);
  }
}
