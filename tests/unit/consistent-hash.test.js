import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { HashRing, hash32 } from '../../src/common/consistent-hash.js';

describe('Consistent hashing — example-based', () => {
  it('TC-HASH-01: the same key always maps to the same shard (deterministic routing)', () => {
    const ring = new HashRing(['shard-a', 'shard-b']);
    expect(ring.getNode('P-ABC123')).toBe(ring.getNode('P-ABC123'));
    expect(new HashRing(['shard-a', 'shard-b']).getNode('P-ABC123')).toBe(ring.getNode('P-ABC123'));
  });

  it('TC-HASH-02: an empty ring throws instead of returning undefined', () => {
    expect(() => new HashRing([]).getNode('x')).toThrow(/empty/);
  });

  it('TC-HASH-03: adding a node twice is idempotent; removing an unknown node is a no-op', () => {
    const ring = new HashRing(['a']);
    ring.addNode('a');
    expect(ring.ring).toHaveLength(150);
    ring.removeNode('zzz');
    expect(ring.ring).toHaveLength(150);
  });

  it('TC-HASH-04: key-space shares sum to 1 and are balanced within ±10% with 150 vnodes', () => {
    const ring = new HashRing(['a', 'b', 'c', 'd']);
    const share = ring.distribution();
    expect(Object.values(share).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
    for (const s of Object.values(share)) expect(Math.abs(s - 0.25)).toBeLessThan(0.1);
  });

  it('TC-HASH-05: hash32 returns an unsigned 32-bit integer', () => {
    for (const k of ['', 'a', 'P-000001', '🙂']) {
      const h = hash32(k);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it('TC-HASH-06: a key hashing past the last vnode wraps around to the first', () => {
    const ring = new HashRing(['a', 'b'], { virtualNodes: 3 });
    const last = ring.ring[ring.ring.length - 1].pos;
    // find a key that hashes beyond the last vnode
    let key;
    for (let i = 0; i < 100000 && !key; i++) if (hash32(`k${i}`) > last) key = `k${i}`;
    expect(key).toBeDefined();
    expect(ring.getNode(key)).toBe(ring.ring[0].node);
  });
});

describe('Consistent hashing — property-based (fast-check)', () => {
  const nodeSet = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 1, maxLength: 8 });

  it('TC-HASH-07: every key maps to a node that is in the ring', () => {
    fc.assert(
      fc.property(nodeSet, fc.string(), (nodes, key) => {
        const ring = new HashRing(nodes, { virtualNodes: 20 });
        return nodes.includes(ring.getNode(key));
      }),
    );
  });

  it('TC-HASH-08: adding a node only moves keys TO the new node (minimal disruption)', () => {
    fc.assert(
      fc.property(nodeSet, fc.array(fc.string(), { minLength: 50, maxLength: 200 }), (nodes, keys) => {
        const ring = new HashRing(nodes, { virtualNodes: 20 });
        const before = keys.map((k) => ring.getNode(k));
        ring.addNode('NEW');
        return keys.every((k, i) => {
          const after = ring.getNode(k);
          return after === before[i] || after === 'NEW';
        });
      }),
    );
  });

  it('TC-HASH-09: removing a node only remaps that node’s keys', () => {
    fc.assert(
      fc.property(nodeSet.filter((n) => n.length >= 2), fc.array(fc.string(), { minLength: 50 }), (nodes, keys) => {
        const ring = new HashRing(nodes, { virtualNodes: 20 });
        const victim = nodes[0];
        const before = keys.map((k) => ring.getNode(k));
        ring.removeNode(victim);
        return keys.every((k, i) => before[i] === victim || ring.getNode(k) === before[i]);
      }),
    );
  });

  it('TC-HASH-10: growing 4 → 5 shards moves roughly 1/5 of keys (vs ~80% for hash mod N)', () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `P-${i}`);
    const ring = new HashRing(['a', 'b', 'c', 'd']);
    const before = keys.map((k) => ring.getNode(k));
    ring.addNode('e');
    const moved = keys.filter((k, i) => ring.getNode(k) !== before[i]).length / keys.length;
    const modMoved = keys.filter((k) => hash32(k) % 4 !== hash32(k) % 5).length / keys.length;
    expect(moved).toBeGreaterThan(0.1);
    expect(moved).toBeLessThan(0.3);
    expect(modMoved).toBeGreaterThan(0.7);
  });
});
