# Test Plan — MediChain Distributed EHR

*Structure follows IEEE 829 / ISO/IEC/IEEE 29119-3.*

## 1. Introduction
**Purpose.** Verify that MediChain meets its functional requirements (secure, consent-based access to health records) and its distributed-systems guarantees (availability under failure, no data loss, no split-brain, encryption, auditability).

**Test items.** Every source module in `src/` (gateway, auth, event bus, audit, notification, Raft storage nodes, common libraries) and the web frontend in `public/`.

## 2. Features to be tested

| Req. ID | Requirement (from the project slides) | Priority |
| --- | --- | --- |
| FR-01 | Users authenticate and receive a signed, short-lived token | High |
| FR-02 | Brute-force protection: account lockout, login rate limit | High |
| FR-03 | Doctors register patients with validated demographics | High |
| FR-04 | Access is role- and consent-based (RBAC + ABAC); admins cannot see PHI | Critical |
| FR-05 | Emergency break-glass access: justified, time-limited, audited, patient alerted | Critical |
| FR-06 | Patients grant and revoke clinician access | High |
| FR-07 | Doctors add and view clinical records (notes, labs, prescriptions, vitals) | High |
| FR-08 | Patients see who accessed their data | High |
| FR-09 | Real-time notifications | Medium |
| FR-10 | Operators monitor and control the cluster | Medium |
| NFR-01 | Availability: survive the crash of any single replica per shard | Critical |
| NFR-02 | Durability & consistency: no acknowledged write is ever lost; replicas converge | Critical |
| NFR-03 | Partition tolerance: no split-brain; minority partitions refuse writes | Critical |
| NFR-04 | Scalability: data sharded across groups; minimal re-mapping when scaling | High |
| NFR-05 | Performance: low-latency reads via caching; bounded failover stall | High |
| NFR-06 | Confidentiality: sensitive fields encrypted at rest (AES-256-GCM) | Critical |
| NFR-07 | Auditability: 100 % of access events logged, tamper-evident | Critical |
| NFR-08 | Exactly-once writes despite client retries and leader changes | High |
| NFR-09 | Resilience patterns: circuit breaker, retry/backoff, async decoupling | High |
| NFR-10 | Security hardening (OWASP API Top 10, XSS, headers, zero trust) | High |
| NFR-11 | Rate limiting / resource consumption | Medium |
| NFR-12 | Observability (metrics, tracing) | Medium |

**Not tested:** real TLS termination (handled by the deployment proxy), multi-host networking, browsers other than Chromium, accessibility audits.

## 3. Approach

### 3.1 Test levels

| Level | Scope | Tooling | Location | Count |
| --- | --- | --- | --- | --- |
| Unit | pure modules in isolation, injected clocks, in-memory Raft network | Vitest, fast-check | `tests/unit` | 197 |
| Integration | each service over real HTTP; 3-node Raft over HTTP with on-disk WAL | Vitest, Supertest | `tests/integration` (services, raft-http) | 28 |
| System (API) | whole cluster in-process: gateway + 5 services + 6 replicas | Vitest, Supertest | `tests/integration/gateway-api`, `security` | 41 |
| Chaos | crash/partition injection while clients write (Jepsen-style) | Vitest | `tests/chaos` | 3 |
| End-to-end | real browser vs the real 11-process cluster | Playwright (POM) | `tests/e2e` | 12 |
| Performance | throughput/latency incl. failover under load | autocannon | `tests/perf` | 5 scenarios |
| Mutation | quality of the unit tests themselves | Stryker | `stryker.config.json` | 7 modules |

(The integration and system rows together make up the 69 tests in `tests/integration`.)

### 3.2 Test design techniques

| Technique | Applied to | Example |
| --- | --- | --- |
| **Equivalence partitioning** | phone, ABHA id, blood group, gender, record types | phone starting 5 = invalid partition |
| **Boundary value analysis** | name length 2/80, age 0/130, heart rate 20/250, SpO₂ 100, note 5000 chars, prescription 1/365 days, lockout N−1/N, breaker threshold, cache TTL, break-glass reason 9/10 chars, grant expiry | `TC-VAL-*`, `TC-CB-02`, `TC-AUTH-03`, `TC-RBAC-29`, `TC-MUT-10` |
| **Decision table** | the access-control policy (role × action × consent × expiry × reason): 28 rules | `tests/unit/rbac.test.js` |
| **State-transition** | circuit breaker CLOSED/OPEN/HALF_OPEN; Raft follower/candidate/leader | `TC-CB-*`, `TC-RAFT-*` |
| **Property-based** | consistent hashing invariants, encryption round-trip over arbitrary unicode | `TC-HASH-07..09`, `TC-CRYPTO-01` |
| **Fault injection / chaos** | crashes, partitions, one-way link cuts, 20 % message loss, majority loss, whole-shard loss | `TC-RAFT-05..15`, `TC-CHAOS-*` |
| **Security testing** | forged JWT, `alg:none`, IDOR, injection, prototype pollution, oversized bodies, brute force, XSS, headers | `TC-SEC-*`, `TC-AUTH-07`, `E2E-08` |
| **Mutation testing** | measures whether tests detect injected bugs; survivors drove new tests | `TC-MUT-*` |
| **Use-case / scenario** | cross-portal flows (doctor ↔ patient ↔ admin) | `E2E-01..12` |

### 3.3 Test-environment strategy
* **Determinism:** clocks are injected (`now`), Raft runs on an in-memory network with controllable partitions and loss, and every service accepts port 0 so tests never collide.
* **Isolation:** each integration file boots its own cluster on random ports with temp data dirs. The E2E run boots a separate cluster on ports +1000 with a throw-away data dir.
* **Realism where it matters:** E2E and Raft-HTTP tests use real processes, sockets and disk.

## 4. Pass / fail criteria
* A test passes when all its assertions hold. The suite passes when **100 %** of tests pass.
* Coverage thresholds (enforced in `vitest.config.js`): lines ≥ 80 %, functions ≥ 80 %, branches ≥ 70 %.
* Mutation score break threshold: 60 % (target ≥ 85 %).
* Chaos acceptance: 0 lost acknowledged writes, 0 duplicates, identical replica state, ≤ 1 leader per term.

## 5. Entry / exit criteria
* **Entry:** `npm install` succeeds; the system boots with `npm start`; no failing build.
* **Exit:** all suites green on 3 consecutive runs (flakiness check); coverage and mutation thresholds met; all defects found are fixed or documented.

## 6. Environment
Windows 11 / Node.js 22, Chromium (Playwright 1.63), Vitest 3.2, Stryker 10. Everything runs locally with no external infrastructure.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Timing-dependent distributed tests become flaky | fast but tolerant Raft timings in tests; `waitUntil` polling instead of fixed sleeps; tests retry against the *current* leader like real clients; 3-run stability check |
| Port collisions | port 0 / pre-reserved free ports; E2E offset +1000 |
| Tests coupled to random ids | lookup by name; ids asserted by format |
| False confidence from coverage | mutation testing (found a vacuous property test, see the report) |

## 8. Requirements traceability matrix

| Req. | Unit | Integration / system | Chaos | E2E |
| --- | --- | --- | --- | --- |
| FR-01 | — | TC-AUTH-01, TC-API-01..03 | — | E2E-01 |
| FR-02 | TC-RL-01..05 | TC-AUTH-03, 04, TC-SEC-06 | — | E2E-02 |
| FR-03 | TC-VAL-NAME/DOB/PII/PWD/USER | TC-API-04..07 | — | E2E-05 |
| FR-04 | TC-RBAC DT-01..28 | TC-API-10..14 | — | E2E-03 |
| FR-05 | DT-14..18 | TC-API-15 | — | E2E-06 |
| FR-06 | DT-22 | TC-API-16, 17 | — | E2E-07 |
| FR-07 | TC-VAL-VITALS, TC-VAL-REC | TC-API-19, 20 | — | E2E-04 |
| FR-08 | TC-CHAIN-01 | TC-API-18 | — | E2E-06 |
| FR-09 | TC-NOTIFY (8 rules) | TC-API-31, 32 | — | E2E-06 |
| FR-10 | — | TC-API-24..30 | — | E2E-09..12 |
| NFR-01 | TC-RAFT-08, 10, 12 | TC-NODE-06 | TC-CHAOS-01, 02 | E2E-10 |
| NFR-02 | TC-RAFT-02, 06, 11, 13, TC-SM-04, TC-WAL-01..03 | TC-NODE-01 | TC-CHAOS-01 | — |
| NFR-03 | TC-RAFT-05, 09, 11, 14, TC-NET-01 | TC-NODE-05 | TC-CHAOS-03 | E2E-10 |
| NFR-04 | TC-HASH-01..10, TC-MUT-01..03 | TC-API-08, 09, 26 | TC-CHAOS-02 | E2E-09 |
| NFR-05 | TC-CACHE-01..04, TC-MUT-10, 11 | TC-API-22, load test | — | — |
| NFR-06 | TC-CRYPTO-01..07 | TC-API-10, 21 | — | E2E-12 |
| NFR-07 | TC-CHAIN-01..06, TC-MUT-12 | TC-AUDIT-01..05, TC-API-11, 18, 27 | — | E2E-11 |
| NFR-08 | TC-RAFT-16, TC-SM-01..05, TC-MUT-14 | TC-API-23, TC-AUDIT-02 | TC-CHAOS-01 | — |
| NFR-09 | TC-CB-01..09, TC-RETRY-01..05, TC-MUT-04..06 | TC-BUS-01..09 | TC-CHAOS-01 | — |
| NFR-10 | TC-VAL-NAME (script) | TC-SEC-01..05, 08, 09, TC-AUTH-02, 07 | — | E2E-08 |
| NFR-11 | TC-RL-01..05, TC-MUT-07..09 | TC-SEC-06, 07 | — | — |
| NFR-12 | TC-MET-01..03 | TC-API-27, 28 | — | — |

Every requirement is covered by at least two test levels. The full list of test cases is in **[TEST_CASES.md](TEST_CASES.md)**.
