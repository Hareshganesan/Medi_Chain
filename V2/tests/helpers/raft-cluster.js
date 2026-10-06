import { RaftNode } from '../../src/raft/raft-node.js';
import { MemoryNetwork } from '../../src/raft/transport.js';
import { MemoryStorage } from '../../src/raft/storage.js';
import { KVStateMachine } from '../../src/raft/kv-state-machine.js';

// Fast but tolerant of a loaded CPU (the full suite may share the machine with a running cluster).
export const FAST = { electionTimeoutMin: 100, electionTimeoutMax: 200, heartbeatInterval: 20, proposalTimeout: 1000 };

/** An in-memory Raft cluster with fault-injection controls, for deterministic tests. */
export function createCluster(size = 3, opts = {}) {
  const ids = Array.from({ length: size }, (_, i) => `n${i + 1}`);
  const network = new MemoryNetwork(opts.network);
  const storages = Object.fromEntries(ids.map((id) => [id, new MemoryStorage()]));
  const nodes = {};

  const boot = (id) => {
    const node = new RaftNode({
      id,
      peers: ids.filter((p) => p !== id),
      transport: network.transportFor(id),
      storage: storages[id],
      stateMachine: new KVStateMachine(),
      ...FAST,
      ...opts.raft,
    });
    network.register(id, node);
    nodes[id] = node;
    node.start();
    return node;
  };
  ids.forEach(boot);

  const cluster = {
    ids,
    nodes,
    network,
    storages,
    live: () => ids.filter((id) => nodes[id]?.running),
    leaders: () => cluster.live().filter((id) => nodes[id].role === 'leader'),
    crash(id) {
      nodes[id].stop();
      network.unregister(id);
    },
    restart: (id) => boot(id),
    async waitForLeader(among = cluster.live(), timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const leaders = among.filter((id) => nodes[id].running && nodes[id].role === 'leader');
        if (leaders.length === 1) return nodes[leaders[0]];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('No single leader elected in time');
    },
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('Condition not met in time');
    },
    /** Client-style write: send to whoever is leader now, retrying across leadership changes. */
    async write(command, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const leader = await cluster.waitForLeader(cluster.live(), Math.max(100, deadline - Date.now()));
        try {
          return await leader.propose(command);
        } catch (err) {
          if (Date.now() > deadline) throw err;
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    },
    stop() {
      for (const id of ids) if (nodes[id].running) nodes[id].stop();
    },
  };
  return cluster;
}
