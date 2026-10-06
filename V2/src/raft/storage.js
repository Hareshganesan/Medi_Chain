import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable Raft state on disk:
 *   meta.json — { term, votedFor }   (atomic write via temp file + rename)
 *   wal.log   — one JSON log entry per line (append-only write-ahead log)
 * Writes are synchronous so state is on disk before the node replies to an RPC.
 */
export class FileStorage {
  constructor(dir) {
    this.dir = dir;
    this.metaPath = path.join(dir, 'meta.json');
    this.walPath = path.join(dir, 'wal.log');
    fs.mkdirSync(dir, { recursive: true });
  }

  load() {
    let meta = {};
    if (fs.existsSync(this.metaPath)) meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    const log = [];
    if (fs.existsSync(this.walPath)) {
      for (const line of fs.readFileSync(this.walPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          log.push(JSON.parse(line));
        } catch {
          break; // torn final write after a crash — discard the partial tail
        }
      }
    }
    return { term: meta.term ?? 0, votedFor: meta.votedFor ?? null, log };
  }

  saveMeta(meta) {
    const tmp = this.metaPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, this.metaPath);
  }

  append(entries) {
    if (entries.length) fs.appendFileSync(this.walPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  rewrite(log) {
    const tmp = this.walPath + '.tmp';
    fs.writeFileSync(tmp, log.map((e) => JSON.stringify(e)).join('\n') + (log.length ? '\n' : ''));
    fs.renameSync(tmp, this.walPath);
  }
}

/** Same contract kept in memory; survives node "restarts" in tests because the object is reused. */
export class MemoryStorage {
  constructor() {
    this.meta = { term: 0, votedFor: null };
    this.entries = [];
  }

  load() {
    return { ...this.meta, log: this.entries.map((e) => ({ ...e })) };
  }

  saveMeta(meta) {
    this.meta = { ...meta };
  }

  append(entries) {
    this.entries.push(...entries.map((e) => ({ ...e })));
  }

  rewrite(log) {
    this.entries = log.map((e) => ({ ...e }));
  }
}
