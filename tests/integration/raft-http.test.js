import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStorageNode } from '../../src/raft/storage-node.js';
import { httpJson } from '../../src/common/http.js';
import { freePorts, waitUntil } from '../helpers/stack.js';

// Slightly relaxed timings: the full suite runs on a loaded CPU and these tests
// are about the HTTP contract, not election speed.
const RAFT = { electionTimeoutMin: 400, electionTimeoutMax: 800, heartbeatInterval: 60, proposalTimeout: 3000 };

/** A real 3-process-style Raft group talking HTTP, with on-disk write-ahead logs. */
const TOKEN = 'raft-token';
const H = { 'x-service-token': TOKEN };
let nodes = {};
let spec;
let dataDir;

const boot = async (n) => {
  nodes[n.id] = await startStorageNode({
    id: n.id,
    shardId: 'test',
    port: n.port,
    peers: spec.filter((p) => p.id !== n.id).map((p) => ({ id: p.id, url: p.url })),
    token: TOKEN,
    dataDir,
    raft: RAFT,
  });
};
const leader = () => Object.values(nodes).find((x) => x.node.running && x.node.role === 'leader' && !x.node.isolated);

/** Like a real client: send to the current leader, follow leadership changes for up to 5 s. */
async function writeToLeader(command) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const l = await waitUntil(leader, 5000);
    const r = await httpJson(`${l.url}/kv/command`, { method: 'POST', headers: H, body: { command }, timeoutMs: 4000 }).catch(() => ({ status: 0 }));
    if (r.status === 200 || r.status === 409 || Date.now() > deadline) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-http-'));
  const ports = await freePorts(3);
  spec = ports.map((port, i) => ({ id: `r${i + 1}`, port, url: `http://127.0.0.1:${port}` }));
  for (const n of spec) await boot(n);
  await waitUntil(leader);
});
afterAll(async () => {
  await Promise.all(Object.values(nodes).map((n) => n.close()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Raft storage nodes over HTTP (integration)', () => {
  it('TC-NODE-01: client write to the leader commits and is readable (strong + eventual)', async () => {
    const w = await writeToLeader({ type: 'put', key: 'k1', value: 'v1' });
    expect(w.status).toBe(200);
    expect(w.data.result).toMatchObject({ ok: true, version: 1 });
    const l = leader();
    await waitUntil(() => l.node.hasReadLease());
    const strong = await httpJson(`${l.url}/kv/get?key=k1&consistency=strong`, { headers: H });
    expect(strong.data.entry.value).toBe('v1');
    const follower = Object.values(nodes).find((x) => x !== l);
    await waitUntil(async () => (await httpJson(`${follower.url}/kv/get?key=k1&consistency=eventual`, { headers: H })).data.entry?.value === 'v1');
  });

  it('TC-NODE-02: follower answers 421 NOT_LEADER with the leader’s URL', async () => {
    const l = leader();
    const follower = Object.values(nodes).find((x) => x !== l);
    await waitUntil(() => follower.node.leaderId === l.node.id);
    const r = await httpJson(`${follower.url}/kv/command`, { method: 'POST', headers: H, body: { command: { type: 'put', key: 'x', value: 1 } } });
    expect(r.status).toBe(421);
    expect(r.data).toMatchObject({ error: 'NOT_LEADER', leaderId: l.node.id, leaderUrl: l.url });
    const strongRead = await httpJson(`${follower.url}/kv/get?key=k1&consistency=strong`, { headers: H });
    expect(strongRead.status).toBe(421);
  });

  it('TC-NODE-03: optimistic-concurrency conflict maps to HTTP 409', async () => {
    const r = await writeToLeader({ type: 'put', key: 'k1', value: 'x', expectedVersion: 0 });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe('VERSION_CONFLICT');
  });

  it('TC-NODE-04: Raft and KV endpoints reject callers without the service token', async () => {
    const l = leader();
    expect((await httpJson(`${l.url}/kv/get?key=k1`)).status).toBe(401);
    expect((await httpJson(`${l.url}/raft/append-entries`, { method: 'POST', body: {} })).status).toBe(401);
    expect((await httpJson(`${l.url}/raft/unknown`, { method: 'POST', headers: H, body: {} })).status).toBe(404);
  });

  it('TC-NODE-05: an isolated leader answers 503 for strong reads and loses leadership', async () => {
    const l = leader();
    await httpJson(`${l.url}/admin/isolate`, { method: 'POST', headers: H, body: { isolated: true } });
    const w = await httpJson(`${l.url}/kv/command`, { method: 'POST', headers: H, body: { command: { type: 'put', key: 'iso', value: 1 } }, timeoutMs: 5000 });
    expect(w.status).toBe(503);
    await waitUntil(() => Object.values(nodes).some((x) => x !== l && x.node.role === 'leader'));
    await httpJson(`${l.url}/admin/isolate`, { method: 'POST', headers: H, body: { isolated: false } });
    await waitUntil(() => l.node.role === 'follower' && l.node.leaderId !== null);
  });

  it('TC-NODE-06: a crashed node restarts from its on-disk WAL and catches up', async () => {
    const victim = Object.values(nodes).find((x) => x.node.role === 'follower');
    const id = victim.node.id;
    await victim.close();
    expect((await writeToLeader({ type: 'put', key: 'while-down', value: 42 })).status).toBe(200);
    await boot(spec.find((s) => s.id === id));
    await waitUntil(() => nodes[id].node.stateMachine.get('while-down')?.value === 42);
    expect(fs.existsSync(path.join(dataDir, 'raft', 'test', id, 'wal.log'))).toBe(true);
    expect(nodes[id].node.stateMachine.get('k1').value).toBe('v1'); // replayed from WAL + leader
  });

  it('TC-NODE-07: /admin/log exposes the raw replicated log for inspection', async () => {
    const l = leader();
    const r = await httpJson(`${l.url}/admin/log?limit=3`, { headers: H });
    expect(r.data.entries.length).toBeLessThanOrEqual(3);
    expect(r.data.entries[0]).toHaveProperty('term');
    const status = await httpJson(`${l.url}/status`);
    expect(status.data).toMatchObject({ role: 'leader' });
  });
});
