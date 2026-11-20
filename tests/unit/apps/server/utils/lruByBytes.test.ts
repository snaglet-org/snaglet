import { describe, expect, it } from '@jest/globals';
import { LruByBytes } from '@server/utils/lruByBytes';

function lru(maxBytes: number, maxEntries = 100) {
  return new LruByBytes<string | null>({
    maxBytes,
    maxEntries,
    sizeOf: (value) => (value ? value.length : 0),
  });
}

describe('LruByBytes', () => {
  it('drops the least recently used entries once the total size is over the limit', () => {
    const cache = lru(10);
    cache.set('a', 'aaaa');
    cache.set('b', 'bbbb');
    cache.get('a');
    cache.set('c', 'cccc');

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('aaaa');
    expect(cache.get('c')).toBe('cccc');
  });

  it('counts a replaced entry at its new size', () => {
    const cache = lru(10);
    cache.set('a', 'aaaaaaaa');
    cache.set('a', 'a');
    cache.set('b', 'bbbbbbbb');

    expect(cache.get('a')).toBe('a');
    expect(cache.get('b')).toBe('bbbbbbbb');
  });

  it('bounds the entry count too, for entries of no size', () => {
    const cache = lru(10, 2);
    cache.set('x', null);
    cache.set('y', null);
    cache.set('z', null);

    expect(cache.get('x')).toBeUndefined();
    expect(cache.get('y')).toBeNull();
    expect(cache.get('z')).toBeNull();
  });
});
