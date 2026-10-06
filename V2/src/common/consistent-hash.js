import { createHash } from 'node:crypto';

/** 32-bit position on the ring derived from MD5 (uniform, fast, stable across processes). */
export function hash32(value) {
  return createHash('md5').update(String(value)).digest().readUInt32BE(0);
}

/**
 * Consistent hashing ring with virtual nodes.
 * Adding or removing a shard only remaps ~1/N of the keys, unlike `hash % N`
 * which remaps almost everything.
 */
export class HashRing {
  constructor(nodes = [], { virtualNodes = 150 } = {}) {
    this.virtualNodes = virtualNodes;
    this.ring = []; // sorted [{ pos, node }]
    this.nodes = new Set();
    for (const n of nodes) this.addNode(n);
  }

  addNode(node) {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);
    for (let i = 0; i < this.virtualNodes; i++) {
      this.ring.push({ pos: hash32(`${node}#${i}`), node });
    }
    this.ring.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : 1));
  }

  removeNode(node) {
    if (!this.nodes.delete(node)) return;
    this.ring = this.ring.filter((v) => v.node !== node);
  }

  /** First virtual node clockwise from the key's position (binary search). */
  getNode(key) {
    if (this.ring.length === 0) throw new Error('HashRing is empty');
    const h = hash32(key);
    let lo = 0;
    let hi = this.ring.length - 1;
    if (h > this.ring[hi].pos) return this.ring[0].node; // wrap around
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].pos < h) lo = mid + 1;
      else hi = mid;
    }
    return this.ring[lo].node;
  }

  /** Fraction of the 2^32 key space owned by each node — shown on the dashboard. */
  distribution() {
    const share = Object.fromEntries([...this.nodes].map((n) => [n, 0]));
    if (this.ring.length === 0) return share;
    const SPACE = 2 ** 32;
    for (let i = 0; i < this.ring.length; i++) {
      const prev = i === 0 ? this.ring[this.ring.length - 1].pos - SPACE : this.ring[i - 1].pos;
      share[this.ring[i].node] += (this.ring[i].pos - prev) / SPACE;
    }
    return share;
  }
}
