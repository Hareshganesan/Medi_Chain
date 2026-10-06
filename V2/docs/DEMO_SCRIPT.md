# Viva / presentation demo script (≈ 8 minutes)

Start the system with `npm start` (use `npm run reset` first for a clean slate). Keep the terminal visible:
it shows coloured logs from all 11 processes, including `became LEADER` messages.

## 1. Architecture in one sentence (30 s)
"Every box on slide 5 is a real process. Patients are sharded across two Raft clusters of three replicas each.
The gateway finds leaders, survives failovers and enforces consent. Everything security-relevant is streamed to a hash-chained audit ledger."

## 2. Consent-based access and break-glass (2 min)
1. Open a **private window** and log in as **hemanth / Patient@123**. Show *My records*, *Who can see my data* and *Access history* (note the "Ledger verified" badge).
2. In the normal window log in as **dr.varun / Doctor@123**. Point out *"8 patients · 2 shards queried in parallel"* (scatter-gather).
3. Click **Hemanth**: access is denied. Explain that the denial was audited.
4. Click **Emergency break-glass access**, type a short reason (rejected: < 10 chars), then a real one. The record opens with a red banner.
5. Switch to Hemanth's window: a **live red alert** has appeared, and *Access history* shows the break-glass entry with its block hash.
6. Point at the **request inspector** strip: *shard, replica (leader), cache HIT/MISS, linearizable, ms*. This is the distributed path made visible.

## 3. Fault tolerance — kill the leader (2 min)
1. Log in as **admin / Admin@123**: the Ops Console. Show the two shard diagrams with animated heartbeats from each leader (★).
2. In **Chaos lab** click **Start write traffic**. Green bars mean writes committed through Raft.
3. Click **Kill leader** on shard-a. Watch:
   * the node turns grey (process SIGKILLed),
   * about 1–2 s later another node becomes ★ leader with a **higher term**,
   * the chaos chart shows one tall/orange bar (the stall during election), but **0 failed**.
4. Click **Restart** on the dead node. It replays its write-ahead log and rejoins as a **follower**. Its commit index catches up.

## 4. Network partition (1 min)
1. Click **Partition** on a leader. The shard elects a new leader. The isolated node can no longer commit (no majority).
2. Click **Heal**. Thanks to **PreVote** the old node simply follows the new leader; there is no extra election.
   "This is the CP side of CAP: a minority never accepts writes, so there's no split-brain."

## 5. Encryption at rest (30 s)
Click **Log** on any replica. The raw Raft log shows `enc:v1:…` ciphertext for phone, ABHA id and notes.
"Storage nodes never see plaintext identifiers."

## 6. Tamper-evident audit (1 min)
In *Audit ledger*: **Tamper** (simulates an insider editing history), then **Verify chain**. The exact block is reported as broken.
**Restore**, then **Verify** again: valid.

## 7. Consistent hashing (30 s)
Type a patient id in *Where does a key live?* and click Locate. The marker shows the key's position on the ring and its owning shard.


---

# Software Testing demo: the QA Lab (≈ 10 minutes)

**Before the audience arrives**
1. Terminal 1: `npm run lab`, then open **http://127.0.0.1:9000**.
2. Click **Unit** once and let it finish. The first run is slower while Vitest warms its cache.
3. Optional: terminal 2, `npm start`, if you also want to show the application itself.

## 1. The strategy at a glance (1 min)
Point at the five numbers across the top: **269 automated tests passing** (plus 12 browser tests), **98.4 % line / 89.0 % branch coverage**, **96.5 % mutation score**, **seeded faults caught**, and **22 / 22 requirements verified**.
Say: "The plan follows IEEE 829. Every requirement is tested at two or more levels: unit, integration, system and security, chaos, end-to-end and performance. The lab is outside the system under test. It drives the real Vitest and Playwright suites and reads the reports they write."

## 2. Live test runner (1.5 min)
1. Click **Unit**. 197 tests run in about 15 seconds, and each square turns green as its test finishes.
2. Click the **validation.test.js** card to expand it. Point out boundary-value cases such as `TC-VAL-DOB 130 years + 1 day` and equivalence classes for phone numbers and ABHA IDs.
3. Click **Security**: 9 OWASP API Top 10 checks against a running cluster (forged tokens, `alg:none`, injection, oversized bodies, brute force).
4. Optional: click **Chaos**. The console prints `[chaos] acked=75 stored=75 … lost=0 dupes=0`, the Jepsen-style result.

## 3. Fault seeding (3 min, the highlight)
Say: "Coverage tells us code ran. It doesn't tell us the tests would notice a bug. So we wrote 14 realistic bugs. The lab injects one into a sandbox copy of the code, never the real source, runs only the tests for that module, and shows whether they catch it."
1. **SF-01, break-glass accepts a 9-character reason.** Click **Inject & test**. It is caught by `TC-RBAC DT-15`, the boundary row with a 9-character reason. *Boundary value analysis.*
2. **SF-07, encryption reuses the same nonce.** It is caught by `TC-CRYPTO-02`. The error shows the ciphertext starting `AAAAAAAA…`: an all-zero nonce. "Decryption still works, so a happy-path test would pass. Only the property *equal plaintexts give different ciphertexts* catches it."
3. **SF-09, Raft commits without a majority.** It is caught by `TC-RAFT-09/11/12`, the fault-injection tests that partition the leader. "This is the bug that loses acknowledged medical records."
4. **SF-03, a patient can open another patient's data.** The decision table catches it. The API test still passes, because the gateway checks ownership a second time. "Defense in depth: the bug wouldn't leak data."
5. Click **Run all seeded faults**. It takes about 75 seconds and ends at **14 / 14 caught, 100 % detection rate**. While it runs, explain the difference from mutation testing (below).

## 4. Browser tests (2 min)
Click **Run in a visible browser**. Playwright starts its own MediChain cluster on ports +1000 with throw-away data. About 20 seconds later a browser window (Microsoft Edge on Windows) signs in as doctors, patients and the admin, in slow motion. The results stream into the live runner: **12 / 12**.
Say: "The tests use the Page Object Model, so a UI change touches one file. E2E-10 kills a Raft leader from the browser and checks that the chaos panel reports zero failed writes."

## 5. Quality evidence (2 min)
1. **Coverage by module.** Every module is above the 80 % line (white marker) target.
2. **Mutation score.** The amber marker is the first Stryker run: 84.4 % overall despite 98 % line coverage. The survivors exposed a property test that verified nothing, clocks starting at zero, and a real circuit-breaker flaw (DEF-08). After 15 targeted tests the score is 96.5 %.
3. **Requirements traceability.** Each requirement links to its test IDs at every level and shows their latest result.
4. **Defect log.** 14 defects found by testing, all fixed. DEF-01 is the most serious: Tamil names were rejected at registration.
5. Open **Coverage report** or **Mutation report** from *Generated reports* to show the tools' own HTML.

## Viva questions to expect
- **Fault seeding vs mutation testing?** Mutation testing generates hundreds of small mechanical changes automatically (Stryker made 486) and reports a score. Fault seeding uses a few realistic bugs, each from a real defect class (security, boundary, concurrency). Both measure the tests, not the code. If the tests catch *s* of *S* seeded faults and *n* real ones, roughly *n × S / s* real defects existed (Mills' seeding model).
- **Why a sandbox?** A test experiment must never risk the real code. Stryker uses the same approach.
- **How do you avoid flaky tests?** Injected clocks, an in-memory Raft network the test controls, random ports per test file, and three consecutive green full runs before a change is accepted (DEF-10 and DEF-14 were flaky tests we fixed).
- **What is the oracle in the chaos test?** Every acknowledged write must exist exactly once on every replica after the faults heal.
- **Is 100 % detection proof of no bugs?** No. It shows the tests catch these kinds of bugs. Testing can show the presence of bugs, never their absence.
- **Exit criteria?** All tests pass, coverage ≥ 80 % lines and ≥ 70 % branches, mutation score ≥ 85 %, 0 lost or duplicated writes, no open High defects.
