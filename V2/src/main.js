/**
 * Process entry point: `node src/main.js <service> [nodeId]`.
 * The supervisor launches one OS process per service / replica, so a crash of
 * one replica is a real process death — exactly what fault tolerance must survive.
 */
import { config, urlOf } from '../cluster.config.js';
import { startAuthService } from './auth/auth-service.js';
import { startEventBus } from './eventbus/event-bus.js';
import { startAuditService } from './audit/audit-service.js';
import { startNotifyService } from './notify/notify-service.js';
import { startGateway } from './gateway/gateway.js';
import { startStorageNode } from './raft/storage-node.js';
import { httpJson } from './common/http.js';

const [service, nodeId] = process.argv.slice(2);
const { services: s, internalToken: token, dataDir } = config;
const shardsWithUrls = config.shards.map((sh) => ({ id: sh.id, nodes: sh.nodes.map((n) => ({ id: n.id, url: urlOf(n) })) }));

const supervisorControl = {
  async kill(id) {
    const r = await httpJson(`${urlOf(s.supervisor)}/processes/${id}/kill`, { method: 'POST', headers: { 'x-service-token': token } });
    if (!r.ok) throw Object.assign(new Error(r.data?.error || 'kill failed'), { status: r.status, expose: true });
  },
  async restart(id) {
    const r = await httpJson(`${urlOf(s.supervisor)}/processes/${id}/restart`, { method: 'POST', headers: { 'x-service-token': token } });
    if (!r.ok) throw Object.assign(new Error(r.data?.error || 'restart failed'), { status: r.status, expose: true });
  },
};

const starters = {
  auth: () => startAuthService({ port: s.auth.port, dataDir, token }),
  eventbus: () => startEventBus({ port: s.eventBus.port, dataDir, token }),
  audit: () => startAuditService({ port: s.audit.port, dataDir, token, busUrl: urlOf(s.eventBus), demoMode: config.demoMode }),
  notify: () => startNotifyService({ port: s.notify.port, token, busUrl: urlOf(s.eventBus), authUrl: urlOf(s.auth) }),
  gateway: () =>
    startGateway({
      port: s.gateway.port,
      shards: shardsWithUrls,
      authUrl: urlOf(s.auth),
      busUrl: urlOf(s.eventBus),
      auditUrl: urlOf(s.audit),
      notifyUrl: urlOf(s.notify),
      controlPlane: supervisorControl,
      internalToken: token,
      encryptionKey: config.encryptionKey,
      demoMode: config.demoMode,
    }),
  node: () => {
    const shard = config.shards.find((sh) => sh.nodes.some((n) => n.id === nodeId));
    if (!shard) throw new Error(`Unknown node id ${nodeId}`);
    const me = shard.nodes.find((n) => n.id === nodeId);
    return startStorageNode({
      id: me.id,
      shardId: shard.id,
      port: me.port,
      peers: shard.nodes.filter((n) => n.id !== me.id).map((n) => ({ id: n.id, url: urlOf(n) })),
      token,
      dataDir,
      raft: config.raft,
    });
  },
};

// Launched by the supervisor: exit if it dies so no orphan keeps a port bound.
if (process.send) process.on('disconnect', () => process.exit(0));

if (!starters[service]) {
  console.error(`Usage: node src/main.js <${Object.keys(starters).join('|')}> [nodeId]`);
  process.exit(1);
}

starters[service]().catch((err) => {
  console.error(`[${service}] failed to start:`, err.message);
  process.exit(1);
});
