import { describe, expect, it } from 'vitest';
import { computeSha256Hex } from './sha256';

describe('computeSha256Hex', () => {
  it('matches the known sha256 digest of a simple string', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const hash = await computeSha256Hex(file);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('matches the known sha256 digest of empty content', async () => {
    const file = new File([], 'empty.txt', { type: 'text/plain' });
    const hash = await computeSha256Hex(file);
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('produces a lowercase hex string with no separators', async () => {
    const file = new File(['some file content'], 'f.bin', { type: 'application/octet-stream' });
    const hash = await computeSha256Hex(file);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different content of the same size', async () => {
    const a = await computeSha256Hex(new File(['aaaa'], 'a.txt'));
    const b = await computeSha256Hex(new File(['bbbb'], 'b.txt'));
    expect(a).not.toBe(b);
  });
});
