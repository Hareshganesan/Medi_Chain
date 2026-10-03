import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON (sorted keys) so the hash never depends on property order. */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function computeHash({ index, timestamp, data, prevHash }) {
  return createHash('sha256').update(canonical({ index, timestamp, data, prevHash })).digest('hex');
}

/** Build the next block: each entry commits to its predecessor's hash. */
export function createEntry(prev, data, timestamp = new Date().toISOString()) {
  const entry = {
    index: prev ? prev.index + 1 : 0,
    timestamp,
    data,
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  entry.hash = computeHash(entry);
  return entry;
}

/**
 * Walk the chain and report the first broken link.
 * Detects edited content, edited hashes, deleted entries and re-ordering.
 */
export function verifyChain(entries) {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.index !== i) return { valid: false, brokenAt: i, reason: 'INDEX_GAP' };
    if (e.prevHash !== prevHash) return { valid: false, brokenAt: i, reason: 'PREV_HASH_MISMATCH' };
    if (computeHash(e) !== e.hash) return { valid: false, brokenAt: i, reason: 'CONTENT_HASH_MISMATCH' };
    prevHash = e.hash;
  }
  return { valid: true, length: entries.length, head: prevHash };
}
