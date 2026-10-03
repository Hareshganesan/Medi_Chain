/**
 * Cluster topology — the single source of truth for service discovery.
 * Every process reads this file, so adding a hospital shard or a replica
 * is a configuration change, not a code change.
 */
const env = process.env;
const host = env.CLUSTER_HOST || '127.0.0.1';
// PORT_OFFSET lets a second cluster (e.g. the E2E test run) live beside the dev one.
const offset = Number(env.PORT_OFFSET || 0);
const port = (name, def) => Number(env[name] || def + offset);

export const config = {
  dataDir: env.DATA_DIR || 'data',
  internalToken: env.INTERNAL_TOKEN || 'dev-internal-service-token-change-me',
  // 32-byte AES-256 key (hex). In production this would live in a KMS / Vault.
  encryptionKey: env.ENCRYPTION_KEY || '6d65646963686169e2c0f0a1b2c3d4e5f60718293a4b5c6d7e8f9011a2b3c4d5',
  demoMode: env.DEMO_MODE !== 'false',

  services: {
    supervisor: { host, port: port('SUPERVISOR_PORT', 7000) },
    auth: { host, port: port('AUTH_PORT', 7001) },
    eventBus: { host, port: port('EVENTBUS_PORT', 7300) },
    audit: { host, port: port('AUDIT_PORT', 7400) },
    notify: { host, port: port('NOTIFY_PORT', 7500) },
    gateway: { host, port: port('GATEWAY_PORT', 8080) },
  },

  // Each shard is an independent Raft group of 3 replicas (tolerates 1 failure each).
  shards: [
    {
      id: 'shard-a',
      nodes: [
        { id: 'a1', host, port: 7101 + offset },
        { id: 'a2', host, port: 7102 + offset },
        { id: 'a3', host, port: 7103 + offset },
      ],
    },
    {
      id: 'shard-b',
      nodes: [
        { id: 'b1', host, port: 7201 + offset },
        { id: 'b2', host, port: 7202 + offset },
        { id: 'b3', host, port: 7203 + offset },
      ],
    },
  ],

  raft: {
    // Deliberately slow enough to watch elections happen on the dashboard.
    electionTimeoutMin: Number(env.RAFT_ELECTION_MIN || 1200),
    electionTimeoutMax: Number(env.RAFT_ELECTION_MAX || 2400),
    heartbeatInterval: Number(env.RAFT_HEARTBEAT || 250),
  },
};

export const urlOf = (svc) => `http://${svc.host}:${svc.port}`;

export default config;
