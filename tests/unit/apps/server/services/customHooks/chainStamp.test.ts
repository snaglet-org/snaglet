/**
 * chainStamp — the chain context a hook-caused message carries so a wake
 * delivered later (busy thread, reaper, retry) keeps its depth.
 */
import { describe, expect, it } from '@jest/globals';
import {
  MAX_HOOK_CHAIN_LENGTH,
  runAtChainDepth,
  runCappedUnattended,
} from '@server/realtime/runContext';
import { runWithActor } from '@server/realtime/actorContext';
import {
  chainStampMetadata,
  mergeChainStamps,
  readChainStamp,
  unknownChainStamp,
} from '@server/services/customHooks/chainStamp';

describe('chainStampMetadata', () => {
  it('stamps nothing at depth 0 (a person’s message)', () => {
    expect(chainStampMetadata()).toBeNull();
  });

  it('stamps the current depth and chain', () => {
    const stamp = runAtChainDepth(2, () => chainStampMetadata(), undefined, ['a', 'b']);
    expect(stamp).toEqual({ chain: { depth: 2, hooks: ['a', 'b'] } });
  });
});

describe('readChainStamp', () => {
  it('reads the server shape', () => {
    expect(readChainStamp({ chain: { depth: 3, hooks: ['a'] }, other: 1 })).toEqual({
      depth: 3,
      hooks: ['a'],
    });
  });

  it.each([
    ['no metadata', null],
    ['no chain key', { source: 'voice' }],
    ['chain is an array', { chain: [3] }],
    ['depth is a string', { chain: { depth: '3', hooks: [] } }],
    ['depth is fractional', { chain: { depth: 2.5, hooks: [] } }],
    ['depth is negative', { chain: { depth: -4, hooks: [] } }],
    ['depth is zero', { chain: { depth: 0, hooks: ['a'] } }],
    ['depth is NaN', { chain: { depth: Number.NaN, hooks: [] } }],
    ['hooks missing', { chain: { depth: 2 } }],
  ])('ignores %s', (_label, metadata) => {
    expect(readChainStamp(metadata)).toBeNull();
  });

  it('drops non-string chain entries', () => {
    expect(readChainStamp({ chain: { depth: 1, hooks: ['a', 7, '', null, 'b'] } })).toEqual({
      depth: 1,
      hooks: ['a', 'b'],
    });
  });
});

describe('unknownChainStamp (a covered row that failed to load)', () => {
  it('records a hook-caused depth of 1 with no chain (depth does not refuse), capped', () => {
    // Unknown origin: whatever it wakes may not auto-approve.
    expect(unknownChainStamp()).toEqual({ depth: 1, hooks: [], capped: true });
  });

  it('is never depth 0 (so the wave does not read as a person’s message)', () => {
    expect(unknownChainStamp().depth).toBeGreaterThanOrEqual(1);
  });

  it('does not outrank a deeper stamp when merged (its cap carries over)', () => {
    expect(mergeChainStamps([null, { depth: 2, hooks: ['a'] }, unknownChainStamp()])).toEqual({
      depth: 2,
      hooks: ['a'],
      capped: true,
    });
  });
});

describe('the unattended cap on a stamp', () => {
  it('is stamped when the sender is capped or is an agent, and survives a read and a merge', () => {
    const plain = runAtChainDepth(1, () => chainStampMetadata(), undefined, ['test-hook-a']);
    expect(plain).toEqual({ chain: { depth: 1, hooks: ['test-hook-a'] } });

    const capped = runAtChainDepth(
      1,
      () => runCappedUnattended(() => chainStampMetadata()),
      undefined,
      ['test-hook-a']
    );
    expect(capped).toEqual({ chain: { depth: 1, hooks: ['test-hook-a'], capped: true } });
    const byAgent = runWithActor(
      { actorKind: 'agent', actorId: 'test-agent-a', actorName: 'Test Agent A' },
      () => runAtChainDepth(1, () => chainStampMetadata(), undefined, ['test-hook-a'])
    );
    expect(byAgent?.chain.capped).toBe(true);

    expect(readChainStamp(capped)).toEqual({ depth: 1, hooks: ['test-hook-a'], capped: true });
    expect(readChainStamp({ chain: { depth: 1, hooks: [], capped: 'yes' } })).toEqual({
      depth: 1,
      hooks: [],
    });
    expect(mergeChainStamps([readChainStamp(plain), readChainStamp(capped)])?.capped).toBe(true);
  });
});

describe('mergeChainStamps', () => {
  it('is null when no message is stamped', () => {
    expect(mergeChainStamps([])).toBeNull();
    expect(mergeChainStamps([null, null])).toBeNull();
  });

  it('takes the deepest depth; an unstamped (person) message never lowers it', () => {
    const merged = mergeChainStamps([
      null,
      { depth: 1, hooks: ['x'] },
      { depth: 3, hooks: ['a', 'b', 'c'] },
      null,
    ]);
    expect(merged).toEqual({ depth: 3, hooks: ['a', 'b', 'c', 'x'] });
  });

  it('keeps the deepest chain first and unions the rest without duplicates', () => {
    expect(
      mergeChainStamps([
        { depth: 2, hooks: ['a', 'b'] },
        { depth: 2, hooks: ['b', 'c'] },
      ])
    ).toEqual({ depth: 2, hooks: ['a', 'b', 'c'] });
  });

  it('caps the merged chain like any chain', () => {
    const long = Array.from({ length: MAX_HOOK_CHAIN_LENGTH }, (_, i) => `h${i}`);
    const merged = mergeChainStamps([
      { depth: 5, hooks: long },
      { depth: 1, hooks: ['extra'] },
    ]);
    expect(merged!.hooks).toHaveLength(MAX_HOOK_CHAIN_LENGTH);
    expect(merged!.hooks[merged!.hooks.length - 1]).toBe('extra');
  });
});
