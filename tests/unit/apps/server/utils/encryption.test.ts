import { randomBytes } from 'crypto';

// Set a valid encryption key before importing the module
const TEST_KEY = randomBytes(32).toString('hex');
process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_KEY;

import { encrypt, decrypt } from '@server/utils/encryption';

describe('encryption', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('should round-trip a simple string', () => {
      const plaintext = 'sk-ant-api03-test-key';
      const ciphertext = encrypt(plaintext);
      expect(decrypt(ciphertext)).toBe(plaintext);
    });

    it('should round-trip an empty string', () => {
      const ciphertext = encrypt('');
      expect(decrypt(ciphertext)).toBe('');
    });

    it('should round-trip unicode content', () => {
      const plaintext = '🔐 secret with émojis and ñ';
      const ciphertext = encrypt(plaintext);
      expect(decrypt(ciphertext)).toBe(plaintext);
    });

    it('should round-trip a long string', () => {
      const plaintext = 'x'.repeat(10000);
      const ciphertext = encrypt(plaintext);
      expect(decrypt(ciphertext)).toBe(plaintext);
    });
  });

  describe('encrypt', () => {
    it('should prefix with v1:', () => {
      const ciphertext = encrypt('test');
      expect(ciphertext.startsWith('v1:')).toBe(true);
    });

    it('should produce different ciphertext each time (random IV)', () => {
      const a = encrypt('same-plaintext');
      const b = encrypt('same-plaintext');
      expect(a).not.toBe(b);
    });

    it('should produce valid base64 after the v1: prefix', () => {
      const ciphertext = encrypt('test');
      const base64Part = ciphertext.slice(3);
      expect(() => Buffer.from(base64Part, 'base64')).not.toThrow();
      // Re-encoding should match (i.e. it's pure base64)
      expect(Buffer.from(base64Part, 'base64').toString('base64')).toBe(base64Part);
    });
  });

  describe('decrypt', () => {
    it('should throw on unknown version prefix', () => {
      expect(() => decrypt('v2:abc')).toThrow('Unknown ciphertext version');
    });

    it('should throw on missing version prefix', () => {
      expect(() => decrypt('abc123')).toThrow('Unknown ciphertext version');
    });

    it('should throw on truncated payload', () => {
      // v1: + base64 of a buffer shorter than IV_LEN(16) + TAG_LEN(16)
      const shortBuf = Buffer.alloc(10).toString('base64');
      expect(() => decrypt(`v1:${shortBuf}`)).toThrow('too short');
    });

    it('should throw on corrupted ciphertext', () => {
      const ciphertext = encrypt('real-secret');
      // Flip an actual payload bit; a fixed replacement character can already
      // occur in the randomized ciphertext and leave it unchanged.
      const payload = Buffer.from(ciphertext.slice(3), 'base64');
      payload[payload.length - 1] ^= 1;
      const corrupted = `v1:${payload.toString('base64')}`;
      expect(() => decrypt(corrupted)).toThrow();
    });
  });

  describe('getKey validation', () => {
    it('should throw when CREDENTIAL_ENCRYPTION_KEY is missing', () => {
      const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      expect(() => encrypt('test')).toThrow('CREDENTIAL_ENCRYPTION_KEY');
      process.env.CREDENTIAL_ENCRYPTION_KEY = original;
    });

    it('should throw when CREDENTIAL_ENCRYPTION_KEY is wrong length', () => {
      const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'abcd';
      expect(() => encrypt('test')).toThrow('64-character hex string');
      process.env.CREDENTIAL_ENCRYPTION_KEY = original;
    });

    it('should throw when CREDENTIAL_ENCRYPTION_KEY has non-hex chars', () => {
      const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'g'.repeat(64);
      expect(() => encrypt('test')).toThrow('64-character hex string');
      process.env.CREDENTIAL_ENCRYPTION_KEY = original;
    });
  });
});
