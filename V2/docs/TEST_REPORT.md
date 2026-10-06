# Test Summary Report — MediChain Distributed EHR

Environment: Windows 11, Node.js 22.14, Vitest 3.2, Playwright 1.63 (Chromium), Stryker 10, autocannon 8.
All numbers below come from actual runs. Re-generate them with the commands in the README.

## 1. Summary

| Metric | Result | Target | Status |
| --- | --- | --- | --- |
| Automated tests | **281 / 281 passing** (269 Vitest + 12 Playwright) | 100 % | ✅ |
| Stability | 4 consecutive full green runs after the flakiness fix (DEF-10) | 3 | ✅ |
| Statement / line coverage | **98.4 %** | ≥ 80 % | ✅ |
| Branch coverage | **89.0 %** | ≥ 70 % | ✅ |
| Function coverage | **99.5 %** | ≥ 80 % | ✅ |
| Mutation score (7 core modules) | **96.5 %** (was 84.4 %) | ≥ 85 % | ✅ |
| Seeded faults detected (QA Lab, §8) | **14 / 14** | all | ✅ |
| Chaos: acknowledged writes lost / duplicated | **0 / 0** of 75, across 3 forced elections + a partition | 0 / 0 | ✅ |
| Client-visible errors during leader failover under load | **0** | 0 | ✅ |

## 2. Results by level

| Level | File | Tests | Result |
| --- | --- | --- | --- |
| Unit | raft-node.test.js | 16 | ✅ |
| Unit | validation.test.js (EP/BVA) | 69 | ✅ |
| Unit | rbac.test.js (decision table) | 29 | ✅ |
| Unit | infrastructure.test.js | 27 | ✅ |
| Unit | mutation-hardening.test.js | 15 | ✅ |
| Unit | crypto-hashchain.test.js | 13 | ✅ |
| Unit | consistent-hash.test.js (incl. property-based) | 10 | ✅ |
| Unit | circuit-breaker.test.js (state transition) | 9 | ✅ |
| Unit | rate-limiter-cache.test.js | 9 | ✅ |
| Integration | services.test.js (auth, event bus, audit) | 21 | ✅ |
| Integration | raft-http.test.js (3 replicas over HTTP + WAL) | 7 | ✅ |
| System | gateway-api.test.js (whole cluster) | 32 | ✅ |
| Security | security.test.js (OWASP API Top 10) | 9 | ✅ |
| Chaos | jepsen-style.test.js | 3 | ✅ |
| E2E | ehr.spec.js (Playwright, real 11-process cluster) | 12 | ✅ |
| **Total** | | **281** | ✅ |

Machine-readable results: `reports/junit.xml`; HTML: `reports/test-report/index.html`, `reports/e2e/index.html`.

## 3. Coverage (V8)

| Module | Stmts % | Branch % | Funcs % | Lines % |
| --- | --- | --- | --- | --- |
| **TOTAL** | **98.37** | **89.01** | **99.52** | **98.37** |
| raft/raft-node.js | 96.39 | 89.00 | 100 | 96.39 |
| raft/kv-state-machine.js | 100 | 100 | 100 | 100 |
| raft/storage.js | 100 | 100 | 100 | 100 |
| gateway/gateway.js | 97.27 | 87.76 | 100 | 97.27 |
| gateway/shard-client.js | 98.23 | 90.16 | 100 | 98.23 |
| common/rbac.js | 100 | 100 | 100 | 100 |
| common/validation.js | 100 | 100 | 100 | 100 |
| common/crypto.js, hash-chain.js, circuit-breaker.js, rate-limiter.js | 100 | 100 | 100 | 100 |

The full table is in `reports/coverage/index.html`. The lowest branch coverage is `logger.js` (colour/level branches) and `audit-service.js` (file-persistence branches that only run with a data dir).

## 4. Mutation testing (Stryker)

Code coverage only shows that code *ran*. Mutation testing shows whether the tests would **notice a bug**.
Stryker generated 486 mutants (e.g. `<` → `<=`, `-` → `+`, deleted statements) in the seven core modules.

| Module | First run | After hardening |
| --- | --- | --- |
| rbac.js | 92.0 % | **100 %** |
| rate-limiter.js | 81.4 % | **100 %** |
| hash-chain.js | 83.0 % | **100 %** |
| kv-state-machine.js | 80.7 % | **97.9 %** |
| lru-cache.js | 87.5 % | **97.5 %** |
| circuit-breaker.js | 81.8 % | **92.4 %** |
| consistent-hash.js | 80.8 % | **88.5 %** |
| **Overall** | **84.4 %** | **96.5 %** |

**What the surviving mutants revealed** (with ~98 % line coverage already in place):
* **A vacuous property test.** `TC-HASH-09` ("removing a node only remaps that node's keys") still passed when `removeNode` was replaced by an empty function. Keys simply kept their old owner, which satisfies the property trivially. `TC-MUT-01` now asserts that no key maps to the removed node.
* **Clock-at-zero blind spot.** Tests started injected clocks at `t = 0`, so `now - openedAt` and `now + openedAt` behaved identically. `TC-MUT-04` and `TC-MUT-07` use realistic epoch times.
* **Untested exact boundaries.** A key hashing *exactly* onto a virtual node, and a cache entry read *exactly* at its expiry, were never exercised (`TC-MUT-02`, `TC-MUT-10`).
* **Dedup only tested indirectly.** State-machine request dedup was covered by Raft tests but not by the unit suite (`TC-MUT-14`).
* **A real design flaw** (DEF-08 below).

The remaining survivors are equivalent mutants. For example, changing a default circuit name never changes behaviour.

## 5. Chaos test (Jepsen-style) result

`TC-CHAOS-01`: 3 concurrent clients × 25 writes each, while a nemesis crashed and restarted the shard leader 3 times and then partitioned a follower.

```
[chaos] acked=75 stored=75 attempts=75 retries=0 terms=1,2,3,4 lost=0 dupes=0
```

* Leadership moved through **4 terms**, so the faults really happened.
* All 75 writes were acknowledged. **0 lost, 0 duplicated**, and all replicas ended byte-identical.
* **0 client retries were needed**: the gateway's shard client absorbed every failover by following the new leader.
* `TC-CHAOS-02`: with an entire shard down, the directory returned partial results flagged `degraded: ["shard-b"]` (graceful degradation).
* `TC-CHAOS-03`: with 2 of 3 replicas down, writes were refused with `503 SHARD_UNAVAILABLE` within the client deadline. No minority leader accepted writes (CP behaviour, no split-brain).

## 6. Performance test (autocannon, 20 connections × 6 s)

| Scenario | req/s | p50 ms | p99 ms | Errors |
| --- | --- | --- | --- | --- |
| Read patient record (cache hit) | 319 | 59 | 282 | 0 |
| Read many patients (mixed hit/miss, 2 shards) | 251 | 78 | 263 | 0 |
| Patient directory (scatter-gather) | 114 | 169 | 344 | 0 |
| Add clinical note (Raft majority commit) | 87 | 231 | 314 | 0 |
| **Writes while the leader is killed** | 66 | 291 | 1041 | **0** |

Interpretation:
* Caching gives roughly 3.7× the throughput of writes. A failover costs about one election timeout of extra tail latency (p99 ≈ 1 s) and **zero failed requests**.
* The whole cluster ran on one Node.js event loop in this harness, so absolute numbers are a lower bound. Separate processes and hosts scale horizontally.

## 7. Defects found and fixed

| ID | Found by | Severity | Description | Fix |
| --- | --- | --- | --- | --- |
| DEF-01 | Unit BVA/EP (`TC-VAL-NAME` Tamil name) | **High** | Names in Indic scripts (e.g. "ஹேமந்த்") were rejected: the regex allowed letters `\p{L}` but not combining vowel signs `\p{M}`. Real patients could not be registered. | Allow `\p{M}` |
| DEF-02 | Smoke test (first boot) | High | Every service crashed at start-up: Zod 3 `discriminatedUnion` cannot contain a refined schema (vitals BP rule). | Move the rule to `superRefine` on the union |
| DEF-03 | Exploratory UI test | Medium | Directory showed "No access" right after a successful break-glass, because consents were read from a follower that lagged by one heartbeat. | Consent part of the directory uses linearizable reads |
| DEF-04 | API smoke test of idempotency | Medium | A retried request (same Idempotency-Key) reported a *different* record id than the original. | State machine returns the original `itemId` on dedup |
| DEF-05 | Test run hygiene | Medium | Killing the supervisor left orphaned child processes holding ports. | Children exit on IPC `disconnect` |
| DEF-06 | E2E-03 | Low | A patient opening `/admin` was bounced through the sign-in page (secure, but confusing). | Redirect straight to the user's own portal |
| DEF-07 | Exploratory UI test | Low | CSS class collisions (`.block`, `.vitals`) broke the sign-in button font and squashed vitals cards. Dark-mode banner contrast was too low. | Renamed classes; dark-theme colours |
| DEF-08 | Mutation testing | Medium | A HALF_OPEN circuit breaker only re-opened on a failed trial because a stale failure count was still above the threshold. A fresh count would have kept it HALF_OPEN. | Reset failures on entering HALF_OPEN; `TC-MUT-05` |
| DEF-09 | Mutation testing | Test defect | Vacuous property test `TC-HASH-09` (see §4). | Strengthened by `TC-MUT-01` |
| DEF-10 | Flakiness check (3 runs) | Test defect | `raft-http` tests failed about 1 in 6 full runs: under CPU load a leader could change between the test looking it up and writing to it. | Tests follow the current leader like a real client; relaxed timings; 4/4 green runs |
| DEF-11 | Code review | Low | Login success events lost the client IP (spreading an Express request drops prototype getters). | Assign `req.user` instead of spreading |
| DEF-12 | Tooling | Tooling | Stryker's Vitest runner activated no mutants with Vitest 5 (score 0 %). | Pinned Vitest 3.2 (supported by Stryker 10) |
| DEF-13 | E2E-10 (after the UI redesign) | Medium | The chaos-lab panel rebuilt its buttons on every probe (5×/s). With the new hover animation, a "Kill leader" click could land on a button that was replaced mid-click, so the click was lost. | Render the panel once, then update stats and bars in place |
| DEF-14 | Full suite run beside a live cluster | Test defect | Raft unit tests with 15 ms heartbeats occasionally saw a load-induced leader change mid-write. | Tests write through a leader-following client helper; timings relaxed to 20 ms / 100–200 ms; 3/3 green under load |

## 8. Fault seeding (QA Lab)

Mutation testing changes code mechanically. Fault seeding complements it with **realistic bugs written by hand**, one per defect class that matters for this system. The QA Lab (`npm run lab`) copies `src/` and `tests/` into a sandbox, applies one fault, runs only the tests for that module and records which test cases fail.

| ID | Seeded fault | Technique that caught it | Caught by |
| --- | --- | --- | --- |
| SF-01 | Break-glass accepts a 9-character reason | Boundary value analysis | TC-RBAC DT-15 |
| SF-02 | Administrators can read patient records | Decision table | TC-RBAC DT-03 |
| SF-03 | A patient can open another patient's data | Decision table | TC-RBAC DT-21, 23, 28 |
| SF-04 | Expired consent and break-glass never end | BVA on time (injected clock) | TC-RBAC DT-10, TC-RBAC-29 |
| SF-05 | Circuit breaker opens one failure too late | State transition | TC-CB-02, 04, 05, 08 |
| SF-06 | Cache ignores expiry, serves stale data | BVA on TTL | TC-CACHE-03, TC-MUT-10 |
| SF-07 | AES-GCM reuses the same nonce | Property: equal plaintexts → different ciphertexts | TC-CRYPTO-02 |
| SF-08 | Audit ledger stops checking content hashes | Negative test (tamper simulation) | TC-CHAIN-03 |
| SF-09 | Raft commits a write without a majority | Fault injection (partition) | TC-RAFT-09, 11, 12 |
| SF-10 | Raft votes for a candidate with an old log | Fault injection (election) | TC-RAFT-04 |
| SF-11 | Retried writes applied twice | Idempotency | TC-SM-05, TC-MUT-14, TC-RAFT-16 |
| SF-12 | Hash ring wraps around to the wrong shard | Boundary (wrap-around position) | TC-HASH-06 |
| SF-13 | Registration accepts a 140-year-old patient | Boundary value analysis | TC-VAL-DOB 130 years + 1 day |
| SF-14 | Phone numbers stored in plaintext | Integration test reading every replica's raw storage | TC-API-21 |

**Result: 14 of 14 seeded faults detected (100 %), in about 75 seconds for the whole campaign.**
SF-03 is also a defense-in-depth result: the policy unit tests catch it, but the API test TC-API-13 still passes because the gateway checks ownership a second time, so the bug would not leak data.
SF-07 and SF-14 show why functional tests alone are not enough: the application still works and returns correct data, and only a security property catches the bug.

The QA Lab itself is covered by 22 self-tests (`npm run test:lab`): the catalogue cannot drift from the code (each fault must match exactly one line), the sandbox never modifies the real source, and a fault run through the HTTP API is detected end to end.

## 9. Conclusion
All exit criteria are met. The suite covers every requirement at two or more levels ([traceability matrix](TEST_PLAN.md#8-requirements-traceability-matrix)).
The distributed-systems guarantees (durability, exactly-once writes, no split-brain, availability under single-replica failure) are verified both deterministically (in-memory network) and against real processes, sockets and disks.
