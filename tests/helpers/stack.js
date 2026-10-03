import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startAuthService } from '../../src/auth/auth-service.js';
import { startEventBus } from '../../src/eventbus/event-bus.js';
import { startAuditService } from '../../src/audit/audit-service.js';
import { startNotifyService } from '../../src/notify/notify-service.js';
import { startGateway } from '../../src/gateway/gateway.js';
import { startStorageNode } from '../../src/raft/storage-node.js';
import { MemoryStorage } from '../../src/raft/storage.js';
import { httpJson } from '../../src/common/http.js';

export const TOKEN = 'test-internal-token';
export const KEY = 'a'.repeat(64);
export const RAFT_FAST = { electionTimeoutMin: 150, electionTimeoutMax: 300, heartbeatInterval: 40, proposalTimeout: 2000 };

/** Reserve N free TCP ports (Raft peers must know each other's addresses up front). */
export async function freePorts(n) {
  const servers = await Promise.all(
    Array.from({ length: n }, () => new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => resolve(s));
    })),
  );
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

export async function waitUntil(fn, timeoutMs = 10000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Boot the complete distributed system in-process on random ports:
 * auth, event bus, audit, notify, gateway and `shards × replicas` Raft nodes.
 * Nodes can be crashed and restarted (state survives in MemoryStorage).
 */
export async function startStack({ shards = 2, replicas = 3, gatewayOptions = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medichain-test-'));
  const auth = await startAuthService({ token: TOKEN, dataDir });
  const bus = await startEventBus({ token: TOKEN });
  const audit = await startAuditService({ token: TOKEN, busUrl: bus.url });
  const notify = await startNotifyService({ token: TOKEN, busUrl: bus.url, authUrl: auth.url });

  const ports = await freePorts(shards * replicas);
  const topology = Array.from({ length: shards }, (_, s) => ({
    id: `shard-${String.fromCharCode(97 + s)}`,
    nodes: Array.from({ length: replicas }, (_, r) => {
      const port = ports[s * replicas + r];
      return { id: `${String.fromCharCode(97 + s)}${r + 1}`, port, url: `http://127.0.0.1:${port}`, storage: new MemoryStorage() };
    }),
  }));

  const running = new Map();
  const bootNode = async (shard, n) => {
    const inst = await startStorageNode({
      id: n.id,
      shardId: shard.id,
      port: n.port,
      peers: shard.nodes.filter((p) => p.id !== n.id).map((p) => ({ id: p.id, url: p.url })),
      token: TOKEN,
      storage: n.storage,
      raft: RAFT_FAST,
    });
    running.set(n.id, inst);
    return inst;
  };
  for (const shard of topology) for (const n of shard.nodes) await bootNode(shard, n);

  const find = (id) => {
    for (const shard of topology) {
      const n = shard.nodes.find((x) => x.id === id);
      if (n) return { shard, n };
    }
    throw new Error(`no node ${id}`);
  };

  const controlPlane = {
    async kill(id) {
      await running.get(id)?.close();
      running.delete(id);
    },
    async restart(id) {
      if (running.has(id)) await controlPlane.kill(id);
      const { shard, n } = find(id);
      await bootNode(shard, n);
    },
  };

  const gateway = await startGateway({
    shards: topology.map((s) => ({ id: s.id, nodes: s.nodes.map(({ id, url }) => ({ id, url })) })),
    authUrl: auth.url,
    busUrl: bus.url,
    auditUrl: audit.url,
    notifyUrl: notify.url,
    controlPlane,
    internalToken: TOKEN,
    encryptionKey: KEY,
    monitorIntervalMs: 200,
    shardClientOptions: { deadlineMs: 6000, timeoutMs: 800 },
    rateLimitOptions: { capacity: 10000, refillPerSec: 10000 },
    loginRateLimitOptions: { capacity: 1000, refillPerSec: 1000 },
    ...gatewayOptions,
  });

  const stack = {
    auth,
    bus,
    audit,
    notify,
    gateway,
    url: gateway.url,
    topology,
    running,
    controlPlane,
    leaderOf(shardId) {
      const shard = topology.find((s) => s.id === shardId);
      return shard.nodes.map((n) => running.get(n.id)?.node).find((node) => node?.role === 'leader' && !node.isolated) ?? null;
    },
    async waitForLeaders() {
      await waitUntil(() => topology.every((s) => stack.leaderOf(s.id)), 10000);
    },
    async login(username, password) {
      const r = await httpJson(`${gateway.url}/api/auth/login`, { method: 'POST', body: { username, password } });
      if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
      return r.data.token;
    },
    async stop() {
      await gateway.close();
      await Promise.all([...running.values()].map((n) => n.close()));
      await notify.close();
      await audit.close();
      await bus.close();
      await auth.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  await stack.waitForLeaders();
  return stack;
}

export const validPatient = (overrides = {}) => ({
  name: 'Mithilesh',
  dob: '1990-05-15',
  gender: 'female',
  bloodGroup: 'O+',
  phone: '9876543210',
  abhaId: '12345678901234',
  allergies: ['Latex'],
  ...overrides,
});
