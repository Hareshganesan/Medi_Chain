import { EventEmitter } from 'node:events';

/**
 * Raft consensus (Ongaro & Ousterhout, "In Search of an Understandable Consensus
 * Algorithm", 2014) — the replication engine behind every record shard.
 *
 * Implemented:
 *  - Leader election with randomized timeouts            (§5.2)
 *  - PreVote, so a rejoining node can't disrupt the cluster (thesis §9.6)
 *  - Log replication + consistency check + fast backtracking (§5.3)
 *  - Commit only current-term entries by counting replicas  (§5.4.2)
 *  - Durable term / vote / log (write-ahead log) before replying (§5 Fig. 2)
 *  - Check-quorum: a leader that loses its majority steps down (thesis §6.2)
 *  - Lease-based linearizable reads on the leader          (thesis §6.4)
 *  - Client-request dedup lives in the state machine (exactly-once, §6.3)
 *
 * Not implemented (documented as future work): snapshots / log compaction,
 * membership changes.
 */

export class NotLeaderError extends Error {
  constructor(leaderId) {
    super('This node is not the leader');
    this.code = 'NOT_LEADER';
    this.leaderId = leaderId ?? null;
  }
}

export class NoQuorumError extends Error {
  constructor(message = 'Could not reach a majority of replicas') {
    super(message);
    this.code = 'NO_QUORUM';
  }
}

export class IsolatedError extends Error {
  constructor() {
    super('Node is network-isolated (simulated partition)');
    this.code = 'ISOLATED';
  }
}

export const ROLE = Object.freeze({ FOLLOWER: 'follower', CANDIDATE: 'candidate', LEADER: 'leader' });

export class RaftNode extends EventEmitter {
  constructor({
    id,
    peers,
    transport,
    storage,
    stateMachine,
    electionTimeoutMin = 150,
    electionTimeoutMax = 300,
    heartbeatInterval = 50,
    proposalTimeout = 5000,
    maxBatch = 64,
    random = Math.random,
    now = Date.now,
    logger,
  }) {
    super();
    Object.assign(this, { id, peers, transport, storage, stateMachine, random, now, logger });
    this.electionTimeoutMin = electionTimeoutMin;
    this.electionTimeoutMax = electionTimeoutMax;
    this.heartbeatInterval = heartbeatInterval;
    this.proposalTimeout = proposalTimeout;
    this.maxBatch = maxBatch;

    // Persistent state (restored from storage in start()).
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = []; // entry at log index i lives at this.log[i - 1]

    // Volatile state.
    this.role = ROLE.FOLLOWER;
    this.leaderId = null;
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.lastLeaderContact = 0;
    this.leaderSince = 0;
    this.termStartIndex = 0;
    this.isolated = false;
    this.running = false;

    // Leader-only state.
    this.nextIndex = {};
    this.matchIndex = {};
    this.lastAck = {};
    this.inflight = {};

    this.waiters = new Map(); // log index → pending client proposal
    this.stats = { elections: 0, termsAsLeader: 0, appendRpcs: 0, voteRpcs: 0 };
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start() {
    const saved = this.storage.load();
    this.currentTerm = saved.term ?? 0;
    this.votedFor = saved.votedFor ?? null;
    this.log = saved.log ?? [];
    this.running = true;
    this.role = ROLE.FOLLOWER;
    this.resetElectionTimer();
    this.logger?.info(`started as follower`, { term: this.currentTerm, logLength: this.log.length });
    return this;
  }

  stop() {
    this.running = false;
    clearTimeout(this.electionTimer);
    clearInterval(this.heartbeatTimer);
    this.failWaiters(new NotLeaderError(null));
    this.removeAllListeners();
  }

  setIsolated(isolated) {
    this.isolated = Boolean(isolated);
    this.emitChange();
  }

  // ───────────────────────────── helpers ─────────────────────────────

  majority() {
    return Math.floor((this.peers.length + 1) / 2) + 1;
  }

  lastIndex() {
    return this.log.length;
  }

  termAt(index) {
    if (index === 0) return 0;
    return this.log[index - 1]?.term ?? -1;
  }

  /** §5.4.1 election restriction: candidate log must be at least as up-to-date. */
  isLogUpToDate(lastLogIndex, lastLogTerm) {
    const myLastTerm = this.termAt(this.lastIndex());
    return lastLogTerm > myLastTerm || (lastLogTerm === myLastTerm && lastLogIndex >= this.lastIndex());
  }

  persistMeta() {
    this.storage.saveMeta({ term: this.currentTerm, votedFor: this.votedFor });
  }

  async send(peer, type, payload) {
    if (this.isolated) throw new IsolatedError();
    const res = await this.transport.send(peer, type, payload);
    if (this.isolated || !this.running) throw new IsolatedError(); // reply lost in the partition
    return res;
  }

  emitChange() {
    this.emit('change', this.status());
  }

  resetElectionTimer() {
    clearTimeout(this.electionTimer);
    if (!this.running) return;
    const span = this.electionTimeoutMax - this.electionTimeoutMin;
    const timeout = this.electionTimeoutMin + Math.floor(this.random() * span);
    this.electionTimer = setTimeout(() => this.onElectionTimeout(), timeout);
  }

  failWaiters(err) {
    for (const [, w] of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.clear();
  }

  // ───────────────────────────── elections ─────────────────────────────

  async onElectionTimeout() {
    if (!this.running || this.role === ROLE.LEADER) return;
    this.resetElectionTimer(); // if this round fails, try again later

    // PreVote: ask "would you vote for me?" without bumping anyone's term.
    const preTerm = this.currentTerm + 1;
    const preOk = await this.collectVotes('preVote', preTerm);
    if (!preOk || !this.running || this.role === ROLE.LEADER || this.currentTerm >= preTerm) return;

    this.currentTerm += 1;
    this.role = ROLE.CANDIDATE;
    this.votedFor = this.id;
    this.leaderId = null;
    this.persistMeta();
    this.stats.elections++;
    this.emitChange();
    this.logger?.info(`election started`, { term: this.currentTerm });

    const term = this.currentTerm;
    const won = await this.collectVotes('requestVote', term);
    if (won && this.running && this.role === ROLE.CANDIDATE && this.currentTerm === term) this.becomeLeader();
  }

  /** Resolve true as soon as a majority grants; false once that becomes impossible. */
  collectVotes(type, term) {
    return new Promise((resolve) => {
      const need = this.majority();
      let granted = 1;
      let settled = 0;
      if (granted >= need) return resolve(true);
      const args = { term, candidateId: this.id, lastLogIndex: this.lastIndex(), lastLogTerm: this.termAt(this.lastIndex()) };
      for (const peer of this.peers) {
        this.stats.voteRpcs++;
        this.send(peer, type, args)
          .then((r) => {
            if (r.term > this.currentTerm) this.stepDown(r.term);
            else if (r.voteGranted) granted++;
          })
          .catch(() => {})
          .finally(() => {
            settled++;
            if (granted >= need) resolve(true);
            else if (settled === this.peers.length) resolve(false);
          });
      }
    });
  }

  handlePreVote({ term, lastLogIndex, lastLogTerm }) {
    this.guardIsolated();
    // Refuse while we still have a live leader — this is what stops a node coming
    // back from a partition with an inflated term from forcing a needless election.
    const leaderAlive =
      this.role === ROLE.LEADER || (this.leaderId !== null && this.now() - this.lastLeaderContact < this.electionTimeoutMin);
    const voteGranted = term > this.currentTerm && !leaderAlive && this.isLogUpToDate(lastLogIndex, lastLogTerm);
    return { term: this.currentTerm, voteGranted };
  }

  handleRequestVote({ term, candidateId, lastLogIndex, lastLogTerm }) {
    this.guardIsolated();
    if (term > this.currentTerm) this.stepDown(term);
    let voteGranted = false;
    if (
      term === this.currentTerm &&
      (this.votedFor === null || this.votedFor === candidateId) &&
      this.isLogUpToDate(lastLogIndex, lastLogTerm)
    ) {
      this.votedFor = candidateId;
      this.persistMeta(); // must be durable before the vote leaves this node
      voteGranted = true;
      this.resetElectionTimer();
    }
    return { term: this.currentTerm, voteGranted };
  }

  stepDown(term) {
    const wasLeader = this.role === ROLE.LEADER;
    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.votedFor = null;
      this.persistMeta();
    }
    if (this.role !== ROLE.FOLLOWER) {
      this.role = ROLE.FOLLOWER;
      clearInterval(this.heartbeatTimer);
      if (wasLeader) {
        this.leaderId = null;
        this.failWaiters(new NotLeaderError(null));
        this.logger?.warn(`stepped down`, { term: this.currentTerm });
      }
    }
    this.resetElectionTimer();
    this.emitChange();
  }

  becomeLeader() {
    this.role = ROLE.LEADER;
    this.leaderId = this.id;
    this.leaderSince = this.now();
    this.stats.termsAsLeader++;
    clearTimeout(this.electionTimer);
    for (const p of this.peers) {
      this.nextIndex[p] = this.lastIndex() + 1;
      this.matchIndex[p] = 0;
      this.lastAck[p] = this.now();
      this.inflight[p] = false;
    }
    // A no-op in the new term lets the leader commit entries from earlier terms (§5.4.2)
    // and tells us when reads are safe (termStartIndex committed).
    this.appendLocal({ type: 'noop' });
    this.termStartIndex = this.lastIndex();
    this.logger?.info(`became LEADER`, { term: this.currentTerm });
    this.emit('leader', { id: this.id, term: this.currentTerm });
    this.emitChange();
    this.advanceCommit();
    this.broadcast();
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.broadcast(), this.heartbeatInterval);
  }

  // ───────────────────────────── replication ─────────────────────────────

  appendLocal(command) {
    const entry = { index: this.lastIndex() + 1, term: this.currentTerm, command };
    this.storage.append([entry]); // write-ahead: durable before anyone is told about it
    this.log.push(entry);
    return entry;
  }

  broadcast() {
    if (this.role !== ROLE.LEADER || !this.running) return;
    if (!this.checkQuorum()) return;
    for (const peer of this.peers) this.replicateTo(peer);
  }

  /** Leader steps down if it hasn't heard from a majority for a full election timeout. */
  checkQuorum() {
    const t = this.now();
    if (t - this.leaderSince < this.electionTimeoutMax) return true;
    const reachable = 1 + this.peers.filter((p) => t - this.lastAck[p] < this.electionTimeoutMax).length;
    if (reachable >= this.majority()) return true;
    this.logger?.warn(`lost quorum (${reachable}/${this.peers.length + 1} reachable) — stepping down`);
    this.stepDown(this.currentTerm);
    return false;
  }

  /** A leader may answer reads locally only while it provably still holds a majority lease. */
  hasReadLease() {
    if (this.role !== ROLE.LEADER || this.isolated) return false;
    if (this.commitIndex < this.termStartIndex) return false;
    const t = this.now();
    const fresh = 1 + this.peers.filter((p) => t - this.lastAck[p] < this.electionTimeoutMin).length;
    return fresh >= this.majority();
  }

  async replicateTo(peer) {
    if (this.role !== ROLE.LEADER || this.inflight[peer]) return;
    this.inflight[peer] = true;
    const term = this.currentTerm;
    const prevLogIndex = this.nextIndex[peer] - 1;
    const entries = this.log.slice(prevLogIndex, prevLogIndex + this.maxBatch);
    let again = false;
    try {
      this.stats.appendRpcs++;
      const r = await this.send(peer, 'appendEntries', {
        term,
        leaderId: this.id,
        prevLogIndex,
        prevLogTerm: this.termAt(prevLogIndex),
        entries,
        leaderCommit: this.commitIndex,
      });
      if (r.term > this.currentTerm) return this.stepDown(r.term);
      if (this.role !== ROLE.LEADER || this.currentTerm !== term) return;
      this.lastAck[peer] = this.now();
      if (r.success) {
        this.matchIndex[peer] = Math.max(this.matchIndex[peer], prevLogIndex + entries.length);
        this.nextIndex[peer] = this.matchIndex[peer] + 1;
        this.advanceCommit();
        again = this.nextIndex[peer] <= this.lastIndex();
      } else {
        // Fast backtracking using the follower's conflict hint instead of one-by-one.
        const hint = r.conflictIndex ?? this.nextIndex[peer] - 1;
        this.nextIndex[peer] = Math.max(1, Math.min(hint, this.nextIndex[peer] - 1));
        again = true;
      }
    } catch {
      // Peer unreachable — the next heartbeat retries.
    } finally {
      this.inflight[peer] = false;
    }
    if (again) setImmediate(() => this.replicateTo(peer));
  }

  handleAppendEntries({ term, leaderId, prevLogIndex, prevLogTerm, entries = [], leaderCommit }) {
    this.guardIsolated();
    if (term < this.currentTerm) return { term: this.currentTerm, success: false };
    if (term > this.currentTerm || this.role !== ROLE.FOLLOWER) this.stepDown(term);
    if (this.leaderId !== leaderId) {
      this.leaderId = leaderId;
      this.emitChange();
    }
    this.lastLeaderContact = this.now();
    this.resetElectionTimer();

    // Consistency check (§5.3): our log must contain prevLogIndex with prevLogTerm.
    if (prevLogIndex > this.lastIndex()) {
      return { term: this.currentTerm, success: false, conflictIndex: this.lastIndex() + 1 };
    }
    if (this.termAt(prevLogIndex) !== prevLogTerm) {
      const badTerm = this.termAt(prevLogIndex);
      let i = prevLogIndex;
      while (i > 1 && this.termAt(i - 1) === badTerm) i--;
      return { term: this.currentTerm, success: false, conflictIndex: i };
    }

    // Append new entries, truncating any conflicting (uncommitted) suffix.
    for (let k = 0; k < entries.length; k++) {
      const at = prevLogIndex + 1 + k;
      if (at <= this.lastIndex() && this.termAt(at) === entries[k].term) continue;
      if (at <= this.lastIndex()) {
        if (at <= this.commitIndex) throw new Error(`Raft safety violation: truncating committed index ${at}`);
        this.log = this.log.slice(0, at - 1);
        this.storage.rewrite(this.log);
        this.logger?.warn(`truncated conflicting log suffix from index ${at}`);
      }
      const rest = entries.slice(k);
      this.storage.append(rest);
      this.log.push(...rest);
      break;
    }

    const lastNew = prevLogIndex + entries.length;
    if (leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(leaderCommit, lastNew);
      this.applyCommitted();
    }
    return { term: this.currentTerm, success: true, matchIndex: lastNew };
  }

  advanceCommit() {
    for (let n = this.lastIndex(); n > this.commitIndex; n--) {
      if (this.termAt(n) !== this.currentTerm) break; // §5.4.2: never count old-term entries directly
      const replicas = 1 + this.peers.filter((p) => this.matchIndex[p] >= n).length;
      if (replicas >= this.majority()) {
        this.commitIndex = n;
        this.applyCommitted();
        break;
      }
    }
  }

  applyCommitted() {
    let changed = false;
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log[this.lastApplied - 1];
      let result;
      let error;
      try {
        result = this.stateMachine.apply(entry.command, entry.index);
      } catch (err) {
        error = err;
      }
      const w = this.waiters.get(entry.index);
      if (w) {
        clearTimeout(w.timer);
        this.waiters.delete(entry.index);
        if (w.term !== entry.term) w.reject(new NotLeaderError(this.leaderId));
        else if (error) w.reject(error);
        else w.resolve({ result, index: entry.index, term: entry.term });
      }
      this.emit('applied', entry);
      changed = true;
    }
    if (changed) this.emitChange();
  }

  // ───────────────────────────── client API ─────────────────────────────

  /** Replicate a command; resolves once it is committed and applied. */
  propose(command) {
    if (this.role !== ROLE.LEADER) return Promise.reject(new NotLeaderError(this.leaderId));
    if (this.isolated) return Promise.reject(new NoQuorumError('Leader is isolated from its followers'));
    const entry = this.appendLocal(command);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(entry.index);
        reject(new NoQuorumError('Write not acknowledged by a majority in time'));
      }, this.proposalTimeout);
      this.waiters.set(entry.index, { term: entry.term, resolve, reject, timer });
    });
    this.advanceCommit(); // single-node cluster commits immediately
    for (const peer of this.peers) this.replicateTo(peer);
    return promise;
  }

  /**
   * strong   → linearizable: only a leader holding a majority lease may answer.
   * eventual → any replica answers from its local state (may be slightly stale).
   */
  read(fn, consistency = 'strong') {
    if (this.isolated && consistency === 'strong') throw new NoQuorumError('Node is isolated');
    if (consistency === 'strong') {
      if (this.role !== ROLE.LEADER) throw new NotLeaderError(this.leaderId);
      if (!this.hasReadLease()) throw new NoQuorumError('Leader cannot confirm its majority lease');
    }
    return fn(this.stateMachine);
  }

  /** Transport entry point for incoming RPCs. */
  handle(type, payload) {
    if (!this.running) throw new Error('Node is stopped');
    switch (type) {
      case 'preVote':
        return this.handlePreVote(payload);
      case 'requestVote':
        return this.handleRequestVote(payload);
      case 'appendEntries':
        return this.handleAppendEntries(payload);
      default:
        throw new Error(`Unknown RPC ${type}`);
    }
  }

  guardIsolated() {
    if (this.isolated) throw new IsolatedError();
  }

  status() {
    return {
      id: this.id,
      role: this.role,
      term: this.currentTerm,
      leaderId: this.leaderId,
      votedFor: this.votedFor,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      logLength: this.lastIndex(),
      isolated: this.isolated,
      keys: this.stateMachine.size?.() ?? undefined,
      stats: this.stats,
      peers:
        this.role === ROLE.LEADER
          ? Object.fromEntries(this.peers.map((p) => [p, { matchIndex: this.matchIndex[p], nextIndex: this.nextIndex[p] }]))
          : undefined,
    };
  }
}
