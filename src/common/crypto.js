import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function keyBuffer(hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (64 hex chars) for AES-256');
  return key;
}

/**
 * Field-level encryption with AES-256-GCM (authenticated encryption).
 * Output: enc:v1:<iv>:<authTag>:<ciphertext> (base64 parts). A fresh 96-bit IV per call
 * means equal plaintexts give different ciphertexts, and the GCM tag detects tampering.
 */
export function encryptField(plaintext, hexKey) {
  if (plaintext === undefined || plaintext === null) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(hexKey), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map((b) => b.toString('base64')).join(':');
}

export function decryptField(value, hexKey) {
  if (!isEncrypted(value)) return value;
  const [iv, tag, ct] = value.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', keyBuffer(hexKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/** Show only the last `visible` characters, e.g. ••••••••9012. */
export function mask(value, visible = 4) {
  if (!value) return value;
  const s = String(value);
  return '•'.repeat(Math.max(0, s.length - visible)) + s.slice(-visible);
}
