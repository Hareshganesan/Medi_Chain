import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStack, validPatient, waitUntil } from '../helpers/stack.js';
import { httpJson, sleep } from '../../src/common/http.js';

/**
 * Chaos / fault-injection test in the spirit of Jepsen.
 *
 *  - CLIENTS: concurrent writers append uniquely-tagged records through the gateway,
 *    retrying failures with the SAME idempotency key (as a real client would).
 *  - NEMESIS: repeatedly crashes the shard leader, restarts it, and partitions replicas.
 *  - CHECKER: after healing, verifies the safety properties:
 *      1. No acknowledged write is lost.
 *      2. No write is applied twice (exactly-once via idempotency keys).
 *      3. All replicas converge to the identical state.
 *      4. At most one leader per term was ever observed (election safety).
 */
let stack;
let token;
let patient;

beforeAll(async () => {
  stack = await startStack();
  token = await stack.login('dr.rohit', 'Doctor@123');
  const r = await httpJson(`${stack.url}/api/patients`, { method: 'POST', body: validPatient({ name: 'Sanku' }), headers: { authorization: `Bearer ${token}` } });
  patient = r.data;
});
afterAll(async () => stack?.stop());

describe('Chaos: availability & safety under leader crashes and partitions', () => {
  it('TC-CHAOS-01: zero acknowledged writes lost, zero duplicates, replicas converge', async () => {
    const shard = stack.topology.find((s) => s.id === patient.shardId);
    const leadersByTerm = new Map();
    const violations = [];
    const watch = setInterval(() => {
      for (const n of shard.nodes) {
        const node = stack.running.get(n.id)?.node;
        if (node?.role !== 'leader' || node.isolated) continue;
        const prev = leadersByTerm.get(node.currentTerm);
        if (prev && prev !== node.id) violations.push({ term: node.currentTerm, a: prev, b: node.id });
        leadersByTerm.set(node.currentTerm, node.id);
      }
    }, 10);

    const acked = new Set();
    const history = { attempts: 0, retries: 0, failedFinal: 0 };
    let stopClients = false;

    const client = async (cid) => {
      for (let i = 0; !stopClients && i < 25; i++) {
        const tag = `c${cid}-w${i}`;
        for (let attempt = 0; attempt < 30; attempt++) {
          history.attempts++;
          const r = await httpJson(`${stack.url}/api/patients/${patient.id}/records`, {
            method: 'POST',
            body: { type: 'note', title: `chaos ${tag}`, content: tag },
            headers: { authorization: `Bearer ${token}`, 'idempotency-key': tag },
            timeoutMs: 10000,
          }).catch(() => ({ status: 0 }));
          if (r.status === 201 || r.status === 200) {
            acked.add(tag);
            break;
          }
          history.retries++;
          if (attempt === 29) history.failedFinal++;
          await sleep(100);
        }
      }
    };

    const nemesis = async () => {
      for (let round = 0; round < 3; round++) {
        await sleep(700);
        const leader = stack.leaderOf(shard.id);
        if (leader) {
          await stack.controlPlane.kill(leader.id); // crash the leader process
          await sleep(900);
          await stack.controlPlane.restart(leader.id); // recover from its log
        }
      }
      // Partition: isolate one follower for a while, then heal.
      const follower = shard.nodes.map((n) => stack.running.get(n.id)?.node).find((n) => n?.role === 'follower');
      follower?.setIsolated(true);
      await sleep(800);
      follower?.setIsolated(false);
    };

    await Promise.all([client(1), client(2), client(3), nemesis()]);
    stopClients = true;
    clearInterval(watch);

    // ── checker ──
    const replicas = () => shard.nodes.map((n) => stack.running.get(n.id).node);
    await waitUntil(() => {
      const r = replicas();
      return r.every((n) => n.lastApplied === r[0].lastApplied && n.commitIndex === r[0].commitIndex) && r.some((n) => n.role === 'leader');
    }, 15000);

    const stored = replicas()[0].stateMachine.get(`records:${patient.id}`).value.map((rec) => rec.title.replace('chaos ', ''));
    const lost = [...acked].filter((t) => !stored.includes(t));
    const dupes = stored.filter((t, i) => stored.indexOf(t) !== i);
    const states = replicas().map((n) => JSON.stringify(n.stateMachine.scan('')));

    console.log(
      `[chaos] acked=${acked.size} stored=${stored.length} attempts=${history.attempts} retries=${history.retries} ` +
        `terms=${[...leadersByTerm.keys()].join(',')} lost=${lost.length} dupes=${dupes.length}`,
    );

    expect(acked.size).toBe(75); // every client write eventually succeeded
    expect(lost).toEqual([]); // 1. durability
    expect(dupes).toEqual([]); // 2. exactly-once
    expect(new Set(states).size).toBe(1); // 3. convergence
    expect(violations).toEqual([]); // 4. election safety
    expect(leadersByTerm.size).toBeGreaterThan(1); // the nemesis really did force elections
  }, 120000);

  it('TC-CHAOS-02: losing a whole shard degrades gracefully — other shard keeps serving', async () => {
    const down = stack.topology.find((s) => s.id !== patient.shardId);
    for (const n of down.nodes) await stack.controlPlane.kill(n.id);
    const dir = await httpJson(`${stack.url}/api/patients`, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 20000 });
    expect(dir.status).toBe(200);
    expect(dir.data.degraded).toEqual([down.id]); // partial results, not a 500
    const read = await httpJson(`${stack.url}/api/patients/${patient.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(read.status).toBe(200); // the healthy shard is unaffected
    for (const n of down.nodes) await stack.controlPlane.restart(n.id);
    await stack.waitForLeaders();
  }, 60000);

  it('TC-CHAOS-03: majority loss makes the shard refuse writes (CP) instead of diverging', async () => {
    const shard = stack.topology.find((s) => s.id === patient.shardId);
    await stack.waitForLeaders();
    const [keep, ...kill] = shard.nodes;
    for (const n of kill) await stack.controlPlane.kill(n.id);
    const t0 = Date.now();
    const r = await httpJson(`${stack.url}/api/patients/${patient.id}/records`, {
      method: 'POST',
      body: { type: 'note', title: 'no quorum', content: 'should not commit' },
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 20000,
    });
    expect(r.status).toBe(503);
    expect(r.data.error).toBe('SHARD_UNAVAILABLE');
    expect(Date.now() - t0).toBeLessThan(15000); // bounded by the client deadline
    expect(stack.running.get(keep.id).node.role).not.toBe('leader');
    for (const n of kill) await stack.controlPlane.restart(n.id);
    await stack.waitForLeaders();
    const ok = await httpJson(`${stack.url}/api/patients/${patient.id}/records`, {
      method: 'POST',
      body: { type: 'note', title: 'quorum back', content: 'ok' },
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 20000,
    });
    expect(ok.status).toBe(201);
  }, 60000);
});
