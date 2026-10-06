# MediChain — Secure & Performance-Optimized Distributed Healthcare Records System

A working implementation of the architecture in *Healthcare_Records_Distributed_Systems.pptx*:
a fault-tolerant, sharded, Raft-replicated electronic health record (EHR) platform with
consent-based access control, field-level encryption, a tamper-evident audit ledger,
and a live operations console where you can **kill and partition nodes while the system keeps working**.

> **Distributed Systems & Applications** · **Software Testing**
> N. Sankkarshana (CH.EN.U4CCE23023) · Ganesan P.V (CH.EN.U4CCE23008) · Hemanth S (CH.EN.U4CCE23013)
> B.Tech Computer & Communication Engineering, Amrita Vishwa Vidyapeetham, Chennai

---

## Quick start (no Docker needed)

Requires **Node.js 20+**.

```bash
npm install
```

```bash
npm start
```

Open **http://127.0.0.1:8080**. The first start boots 11 OS processes (gateway, auth, event bus,
audit, notifications and **2 shards × 3 Raft replicas**), elects leaders and seeds demo data through the public API.

| Account | Password | Portal |
| --- | --- | --- |
| `dr.rohit` | `Doctor@123` | Clinician — treating cardiologist |
| `dr.varun` | `Doctor@123` | Clinician — emergency physician *(no consent → try break-glass)* |
| `dr.nikhil` | `Doctor@123` | Clinician — general medicine |
| `hemanth` / `sanku` | `Patient@123` | Patient portal |
| `admin` | `Admin@123` | Operations console (cluster, chaos lab, audit ledger) |

Reset all data with `npm run reset`.

## What it demonstrates

| Slide concept | Where it lives |
| --- | --- |
| API Gateway (auth, rate limiting, routing) | [src/gateway/gateway.js](src/gateway/gateway.js) |
| Microservices: Auth / Record / Notification / Audit | [src/auth](src/auth), [src/raft](src/raft), [src/notify](src/notify), [src/audit](src/audit) |
| **Consensus (Raft) — leader election, log replication, failover** | [src/raft/raft-node.js](src/raft/raft-node.js) |
| Write-ahead log, crash recovery | [src/raft/storage.js](src/raft/storage.js) |
| Sharding with consistent hashing (150 virtual nodes) | [src/common/consistent-hash.js](src/common/consistent-hash.js) |
| Kafka-style event streaming (topics, offsets, consumer groups) | [src/eventbus/event-bus.js](src/eventbus/event-bus.js) |
| Circuit breakers, retry + exponential backoff with jitter | [src/common/circuit-breaker.js](src/common/circuit-breaker.js), [src/common/http.js](src/common/http.js) |
| Redis-style cache-aside (LRU + TTL) | [src/common/lru-cache.js](src/common/lru-cache.js) |
| JWT (RS256) + RBAC/ABAC + patient consent + break-glass | [src/auth/auth-service.js](src/auth/auth-service.js), [src/common/rbac.js](src/common/rbac.js) |
| AES-256-GCM field-level encryption | [src/common/crypto.js](src/common/crypto.js) |
| Immutable, hash-chained audit trail (blockchain option) | [src/common/hash-chain.js](src/common/hash-chain.js) |
| Observability: Prometheus `/metrics`, request tracing | [src/common/metrics.js](src/common/metrics.js) |
| Control plane (process supervisor ≈ mini-Kubernetes) | [src/supervisor/index.js](src/supervisor/index.js) |

Full design write-up: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## The 5-minute demo (for the viva)

See **[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)**. The highlights:

1. **Consent & break-glass.** Dr. Varun opens Hemanth's record and is denied; the denial is audited. He uses emergency break-glass, and Hemanth's portal shows a red alert in real time.
2. **Leader crash.** In the Ops Console, start write traffic, then kill a shard leader. A new leader is elected in about 2 seconds and the chaos chart shows **0 failed writes**.
3. **Network partition.** Partition a leader. The rest of the shard elects a new leader. On healing, the old leader rejoins as a follower, and PreVote stops it from disrupting the cluster.
4. **Encryption at rest.** Open a replica's raw log: phone numbers, ABHA ids and clinical notes are stored as ciphertext.
5. **Tamper detection.** Tamper with the audit ledger, click *Verify chain*, and the exact edited block is identified.

## Testing (Software Testing subject)

| Command | What it runs |
| --- | --- |
| `npm test` | Unit, integration, security and chaos tests (Vitest) — **269 tests** |
| `npm run test:coverage` | Same, with V8 coverage (HTML in `reports/coverage`) |
| `npm run test:e2e` | **12 browser E2E tests** (Playwright) against the real multi-process cluster |
| `npm run test:e2e:demo` | The same browser tests in a visible, slowed-down Chromium window |
| `npm run test:ui` | Vitest's own browser UI for exploring and re-running tests |
| `npm run test:mutation` | Mutation testing (Stryker) of the core modules |
| `npm run test:load` | Load / performance test (autocannon), writes `reports/load-test.md` |
| `npm run lab` | **QA Lab** on http://127.0.0.1:9000 — the live testing demo console (below) |
| `npm run test:lab` | 22 self-tests for the QA Lab tooling |

First-time E2E setup: `npx playwright install chromium`.

### QA Lab: the live testing demo

`npm run lab` opens a console for demonstrating the testing work, separate from the system under test:

- **Live test runner.** Runs the unit, integration, security, chaos or full suite and shows every test case as a square that turns green or red as it finishes.
- **Fault seeding.** 14 realistic bugs (an off-by-one boundary, admin reading patient data, a reused AES-GCM nonce, Raft committing without a majority, plaintext phone numbers…). Each is injected into a sandbox copy of the code, never the real source, and only the relevant tests run. The lab shows which test cases caught it and their assertion messages. **14 of 14 are caught.**
- **Browser tests.** Launches the 12 Playwright tests in a visible, slowed-down browser window (the installed Microsoft Edge on Windows), streaming results into the runner.
- **Quality metrics.** Coverage by module, mutation score before and after hardening, test cases by design technique, load-test results and links to every HTML report.
- **Traceability and defects.** Each requirement linked to its test cases and their latest result, and the defect log.

**Results:** 281/281 passing · **98.4 % statement/line coverage** (89.0 % branch) ·
**96.5 % mutation score** (up from 84.4 % after mutation-driven hardening) ·
chaos test: 75/75 writes acknowledged, **0 lost, 0 duplicated**, across 3 forced leader elections.

- Test plan, techniques, test-case catalogue & traceability matrix: **[docs/TEST_PLAN.md](docs/TEST_PLAN.md)**
- Results, coverage, mutation analysis, defects found: **[docs/TEST_REPORT.md](docs/TEST_REPORT.md)**

## Project layout

```
cluster.config.js        topology & ports (single source of truth for service discovery)
src/
  raft/                  Raft consensus, WAL storage, KV state machine, storage-node HTTP API
  gateway/               API gateway, shard client (leader tracking + failover), cluster monitor, data layer
  auth/ eventbus/ audit/ notify/    microservices
  common/                consistent hashing, circuit breaker, rate limiter, cache, crypto, RBAC, metrics, validation
  supervisor/            launches every service as its own OS process; kill/restart control plane; seeding
public/                  frontend: login, clinician portal, patient portal, operations console (no build step)
tests/
  unit/ integration/ chaos/ e2e/ perf/    see docs/TEST_PLAN.md
docs/                    architecture, test plan, test report, demo script
```

## Tech choices (and how they map to the slides)

The slides name production tools (Kafka, Redis, PostgreSQL, Keycloak, Kubernetes). To keep the project runnable
on any laptop with **one command and no external infrastructure**, each is implemented in miniature with the
same semantics. That is also what makes every mechanism visible and testable:

| Slide | Implemented as | Same core idea |
| --- | --- | --- |
| Kafka | `eventbus` service | append-only topic log, offsets, consumer groups, at-least-once delivery |
| Redis cache | gateway LRU cache | cache-aside, TTL, invalidation on write |
| Sharded PostgreSQL + replicas | Raft-replicated KV shards | consistent-hash sharding, majority replication, leader failover |
| etcd / ZooKeeper | our own Raft | the same consensus algorithm etcd uses |
| Keycloak (OAuth2/OIDC) | `auth` service | RS256 JWTs verified by every service with a public key |
| Kubernetes | `supervisor` | process lifecycle, health checks, restart on demand |
| Prometheus + Grafana | `/metrics` + Ops Console | Prometheus text format; live dashboard |
