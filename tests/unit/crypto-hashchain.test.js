import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { encryptField, decryptField, isEncrypted, mask } from '../../src/common/crypto.js';
import { createEntry, verifyChain, canonical, GENESIS_HASH } from '../../src/common/hash-chain.js';

const KEY = '0f'.repeat(32);

describe('Field-level encryption (AES-256-GCM)', () => {
  it('TC-CRYPTO-01: round-trips any unicode string (property-based)', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme' }), (s) => decryptField(encryptField(s, KEY), KEY) === s));
  });

  it('TC-CRYPTO-02: the same plaintext encrypts to different ciphertexts (random IV)', () => {
    const a = encryptField('9876543210', KEY);
    const b = encryptField('9876543210', KEY);
    expect(a).not.toBe(b);
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toContain('9876543210');
  });

  it('TC-CRYPTO-03: tampered ciphertext is rejected by the GCM auth tag', () => {
    const enc = encryptField('secret diagnosis', KEY);
    const parts = enc.split(':');
    const ct = Buffer.from(parts[4], 'base64');
    ct[0] ^= 0xff;
    parts[4] = ct.toString('base64');
    expect(() => decryptField(parts.join(':'), KEY)).toThrow();
  });

  it('TC-CRYPTO-04: decrypting with the wrong key fails', () => {
    expect(() => decryptField(encryptField('x', KEY), 'ab'.repeat(32))).toThrow();
  });

  it('TC-CRYPTO-05: rejects keys that are not 256-bit', () => {
    expect(() => encryptField('x', 'abcd')).toThrow(/32 bytes/);
  });

  it('TC-CRYPTO-06: null/undefined and plaintext values pass through unchanged', () => {
    expect(encryptField(null, KEY)).toBeNull();
    expect(encryptField(undefined, KEY)).toBeUndefined();
    expect(decryptField('legacy plaintext', KEY)).toBe('legacy plaintext');
  });

  it('TC-CRYPTO-07: mask keeps only the last 4 characters', () => {
    expect(mask('12345678901234')).toBe('••••••••••1234');
    expect(mask('12')).toBe('12');
    expect(mask('')).toBe('');
  });
});

describe('Tamper-evident hash chain', () => {
  const build = (n) => {
    const chain = [];
    for (let i = 0; i < n; i++) chain.push(createEntry(chain[i - 1], { type: 'RECORD_READ', i }, `2026-01-01T00:00:0${i}Z`));
    return chain;
  };

  it('TC-CHAIN-01: a freshly built chain verifies; the genesis entry links to 64 zeros', () => {
    const chain = build(5);
    expect(chain[0].prevHash).toBe(GENESIS_HASH);
    expect(verifyChain(chain)).toMatchObject({ valid: true, length: 5, head: chain[4].hash });
  });

  it('TC-CHAIN-02: an empty chain is valid', () => {
    expect(verifyChain([]).valid).toBe(true);
  });

  it('TC-CHAIN-03: editing an entry’s content is detected at that index', () => {
    const chain = build(5);
    chain[2].data.i = 999;
    expect(verifyChain(chain)).toMatchObject({ valid: false, brokenAt: 2, reason: 'CONTENT_HASH_MISMATCH' });
  });

  it('TC-CHAIN-04: re-hashing an edited entry still breaks the NEXT link', () => {
    const chain = build(5);
    chain[2].data.i = 999;
    chain[2].hash = createEntry(chain[1], chain[2].data, chain[2].timestamp).hash;
    expect(verifyChain(chain)).toMatchObject({ valid: false, brokenAt: 3, reason: 'PREV_HASH_MISMATCH' });
  });

  it('TC-CHAIN-05: deleting an entry is detected', () => {
    const chain = build(5);
    chain.splice(2, 1);
    expect(verifyChain(chain)).toMatchObject({ valid: false, brokenAt: 2, reason: 'INDEX_GAP' });
  });

  it('TC-CHAIN-06: canonical JSON is independent of key order', () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonical({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });
});
