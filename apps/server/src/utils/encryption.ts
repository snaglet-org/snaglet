/**
 * Credential encryption utility — AES-256-GCM
 *
 * Wire format:  v1:<base64(iv[16] || authTag[16] || ciphertext[N])>
 *
 * The "v1:" prefix is a version sentinel that enables future key rotation:
 * add a v2 key, emit "v2:", branch on prefix in decrypt(). No schema changes needed.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, body]).toString('base64')}`;
}

export function decrypt(value: string): string {
  if (!value.startsWith('v1:')) {
    throw new Error(`Unknown ciphertext version: "${value.slice(0, 10)}"`);
  }
  const key = getKey();
  const buf = Buffer.from(value.slice(3), 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('Ciphertext payload too short — data is corrupt');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
