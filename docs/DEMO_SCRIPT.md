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

## 8. Testing (1 min — for the Software Testing viva)
Run `npm test` (≈ 40 s, 269 tests) and open `reports/test-report/index.html`, `reports/coverage/index.html` and `reports/mutation/index.html`.
Talking points: the decision table for RBAC, BVA on vitals and age, property-based testing of consistent hashing,
the Jepsen-style chaos test (0 lost / 0 duplicate writes), and the mutation-testing story (84 % → 96.5 %, found a vacuous property test).
