import { describe, it, expect, afterEach } from 'vitest';
import { createCluster } from '../helpers/raft-cluster.js';
import { RaftNode, NotLeaderError } from '../../src/raft/raft-node.js';
import { MemoryStorage } from '../../src/raft/storage.js';
import { KVStateMachine } from '../../src/raft/kv-state-machine.js';

/**
 * Raft safety & liveness properties, verified on an in-memory network
 * with injected crashes and partitions.
 */
let cluster;
afterEach(() => cluster?.stop());

const put = (key, value, extra = {}) => ({ type: 'put', key, value, ...extra });

describe('Raft — leader election', () => {
  it('TC-RAFT-01: elects exactly one leader in a fresh 3-node cluster', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    expect(cluster.leaders()).toEqual([leader.id]);
    // every follower learns who the leader is
    await cluster.waitFor(() => cluster.ids.every((id) => cluster.nodes[id].leaderId === leader.id));
  });

  it('TC-RAFT-02: election safety — never two leaders in the same term', async () => {
    cluster = createCluster(5);
    const seen = new Map(); // term → leader id
    const violations = [];
    for (const id of cluster.ids) {
      cluster.nodes[id].on('leader', ({ id: who, term }) => {
        if (seen.has(term) && seen.get(term) !== who) violations.push({ term, a: seen.get(term), b: who });
        seen.set(term, who);
      });
    }
    // force several elections by crashing leaders repeatedly
    for (let round = 0; round < 3; round++) {
      const leader = await cluster.waitForLeader();
      cluster.crash(leader.id);
      await cluster.waitForLeader(cluster.live());
      cluster.restart(leader.id);
      for (const id of cluster.ids) {
        cluster.nodes[id].on('leader', ({ id: who, term }) => {
          if (seen.has(term) && seen.get(term) !== who) violations.push({ term });
          seen.set(term, who);
        });
      }
    }
    expect(violations).toEqual([]);
  });

  it('TC-RAFT-03: a single-node cluster elects itself and commits alone', async () => {
    const node = new RaftNode({
      id: 'solo',
      peers: [],
      transport: { send: async () => ({}) },
      storage: new MemoryStorage(),
      stateMachine: new KVStateMachine(),
      electionTimeoutMin: 20,
      electionTimeoutMax: 40,
    }).start();
    await new Promise((r) => setTimeout(r, 80));
    expect(node.role).toBe('leader');
    const { result } = await node.propose(put('k', 1));
    expect(result.ok).toBe(true);
    node.stop();
  });

  it('TC-RAFT-04: rejects a vote for a candidate whose log is behind (election restriction §5.4.1)', () => {
    const node = new RaftNode({ id: 'x', peers: ['y'], transport: {}, storage: new MemoryStorage(), stateMachine: new KVStateMachine() });
    node.log = [{ index: 1, term: 3, command: { type: 'noop' } }];
    node.currentTerm = 3;
    node.running = true;
    const stale = node.handleRequestVote({ term: 4, candidateId: 'y', lastLogIndex: 5, lastLogTerm: 2 });
    expect(stale.voteGranted).toBe(false);
    const fresh = node.handleRequestVote({ term: 4, candidateId: 'y', lastLogIndex: 1, lastLogTerm: 3 });
    expect(fresh.voteGranted).toBe(true);
    // only one vote per term
    const second = node.handleRequestVote({ term: 4, candidateId: 'z', lastLogIndex: 9, lastLogTerm: 9 });
    expect(second.voteGranted).toBe(false);
    node.stop();
  });

  it('TC-RAFT-05: PreVote — a node rejoining after isolation does not depose a healthy leader', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    const termBefore = leader.currentTerm;
    const victim = cluster.ids.find((id) => id !== leader.id);
    cluster.network.partition([victim], cluster.ids.filter((id) => id !== victim));
    await new Promise((r) => setTimeout(r, 500)); // victim times out repeatedly, but PreVote fails
    expect(cluster.nodes[victim].currentTerm).toBe(termBefore); // term did NOT inflate
    cluster.network.heal();
    await new Promise((r) => setTimeout(r, 200));
    expect(leader.role).toBe('leader');
    expect(leader.currentTerm).toBe(termBefore);
  });
});

describe('Raft — log replication', () => {
  it('TC-RAFT-06: a committed write is applied on every replica in the same order', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    for (let i = 0; i < 20; i++) await cluster.write(put(`k${i}`, i));
    await cluster.waitFor(() => cluster.ids.every((id) => cluster.nodes[id].lastApplied === cluster.nodes[cluster.ids[0]].lastApplied && cluster.nodes[id].lastApplied >= 21));
    const snapshots = cluster.ids.map((id) => JSON.stringify(cluster.nodes[id].stateMachine.scan('')));
    expect(new Set(snapshots).size).toBe(1);
    expect(cluster.nodes[cluster.ids[0]].stateMachine.get('k19').value).toBe(19);
  });

  it('TC-RAFT-07: followers refuse client writes and point to the leader', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    await cluster.waitFor(() => cluster.ids.every((id) => cluster.nodes[id].leaderId === leader.id));
    const follower = cluster.nodes[cluster.ids.find((id) => id !== leader.id)];
    await expect(follower.propose(put('a', 1))).rejects.toMatchObject({ code: 'NOT_LEADER', leaderId: leader.id });
  });

  it('TC-RAFT-08: a write commits with one replica down (2 of 3 is a majority)', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    cluster.crash(cluster.ids.find((id) => id !== leader.id));
    const { result } = await leader.propose(put('k', 'v'));
    expect(result.ok).toBe(true);
  });

  it('TC-RAFT-09: a write does NOT commit when the leader is cut off from the majority', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    const others = cluster.ids.filter((id) => id !== leader.id);
    cluster.network.partition([leader.id], others);
    await expect(leader.propose(put('lost', 1))).rejects.toMatchObject({ code: expect.stringMatching(/NO_QUORUM|NOT_LEADER/) });
    expect(leader.stateMachine.get('lost')).toBeNull();
  });

  it('TC-RAFT-10: a restarted follower catches up from the leader', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    const follower = cluster.ids.find((id) => id !== leader.id);
    cluster.crash(follower);
    for (let i = 0; i < 10; i++) await cluster.write(put(`x${i}`, i));
    cluster.restart(follower);
    await cluster.waitFor(() => cluster.nodes[follower].stateMachine.get('x9')?.value === 9);
  });

  it('TC-RAFT-11: an isolated old leader discards its uncommitted entries after healing', async () => {
    cluster = createCluster(3);
    const oldLeader = await cluster.waitForLeader();
    await oldLeader.propose(put('base', 0));
    const others = cluster.ids.filter((id) => id !== oldLeader.id);
    cluster.network.partition([oldLeader.id], others);
    oldLeader.propose(put('ghost', 'never-committed')).catch(() => {});
    const newLeader = await cluster.waitForLeader(others);
    await newLeader.propose(put('real', 'committed'));
    cluster.network.heal();
    await cluster.waitFor(() => oldLeader.stateMachine.get('real')?.value === 'committed');
    expect(oldLeader.role).toBe('follower');
    expect(oldLeader.stateMachine.get('ghost')).toBeNull();
    expect(oldLeader.log.some((e) => e.command.key === 'ghost')).toBe(false);
  });
});

describe('Raft — fault tolerance & durability', () => {
  it('TC-RAFT-12: leader crash → new leader elected and keeps all committed data', async () => {
    cluster = createCluster(3);
    await cluster.waitForLeader();
    for (let i = 0; i < 5; i++) await cluster.write(put(`d${i}`, i));
    const leader = await cluster.waitForLeader(); // whoever leads now
    cluster.crash(leader.id);
    const next = await cluster.waitForLeader(cluster.live());
    expect(next.id).not.toBe(leader.id);
    expect(next.currentTerm).toBeGreaterThan(leader.currentTerm);
    await next.propose(put('after', true));
    for (let i = 0; i < 5; i++) expect(next.stateMachine.get(`d${i}`).value).toBe(i);
  });

  it('TC-RAFT-13: term, vote and log survive a full-cluster restart (write-ahead log)', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    await cluster.write(put('durable', 'yes'));
    const term = Math.max(...cluster.ids.map((id) => cluster.nodes[id].currentTerm));
    for (const id of cluster.ids) cluster.crash(id);
    for (const id of cluster.ids) cluster.restart(id);
    const back = await cluster.waitForLeader();
    expect(back.currentTerm).toBeGreaterThan(term);
    await cluster.waitFor(() => back.stateMachine.get('durable')?.value === 'yes');
  });

  it('TC-RAFT-14: leader without a majority steps down (check-quorum) and refuses strong reads', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    await cluster.waitFor(() => leader.hasReadLease()); // no-op of the new term committed
    expect(leader.read((sm) => sm.size(), 'strong')).toBeGreaterThanOrEqual(0);
    cluster.network.partition([leader.id], cluster.ids.filter((id) => id !== leader.id));
    await cluster.waitFor(() => leader.role === 'follower', 2000);
    expect(() => leader.read((sm) => sm.size(), 'strong')).toThrow(NotLeaderError);
    // ...but eventual reads still work from local state (availability over consistency)
    expect(leader.read((sm) => sm.size(), 'eventual')).toBeGreaterThanOrEqual(0);
  });

  it('TC-RAFT-15: makes progress despite 20% random message loss', async () => {
    cluster = createCluster(3, { network: { dropRate: 0.2 }, raft: { proposalTimeout: 3000 } });
    const leader = await cluster.waitForLeader(undefined, 5000);
    let ok = 0;
    for (let i = 0; i < 10; i++) {
      try {
        const l = cluster.nodes[cluster.leaders()[0]] ?? leader;
        await l.propose(put(`lossy${i}`, i));
        ok++;
      } catch {
        /* leadership may move under loss — that is allowed */
      }
    }
    expect(ok).toBeGreaterThan(5);
  });

  it('TC-RAFT-16: duplicate client request (same requestId) is applied exactly once', async () => {
    cluster = createCluster(3);
    const leader = await cluster.waitForLeader();
    const cmd = { type: 'append', key: 'list', value: 'item', requestId: 'req-1' };
    await leader.propose(cmd);
    const second = await leader.propose(cmd);
    expect(second.result.duplicate).toBe(true);
    expect(leader.stateMachine.get('list').value).toEqual(['item']);
  });
});
