/** The DM pair key: one key per pair of members, whichever side starts the DM. */

import { describe, expect, it } from '@jest/globals';
import { dmPairKey } from '@server/services/dm/dmPairKey';

describe('dmPairKey', () => {
  it('dmPairKey is order independent', () => {
    expect(dmPairKey('member-b', 'member-a')).toBe('member-a:member-b');
    expect(dmPairKey('member-a', 'member-b')).toBe('member-a:member-b');
  });

  it('refuses a self pair and a blank member', () => {
    expect(() => dmPairKey('member-a', 'member-a')).toThrow(/two different members/);
    expect(() => dmPairKey('', 'member-a')).toThrow(/two member ids/);
  });
});
