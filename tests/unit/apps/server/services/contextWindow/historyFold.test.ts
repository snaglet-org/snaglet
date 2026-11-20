import { describe, expect, it } from '@jest/globals';
import type { ProviderMessage } from '@server/services/ProviderChatService';
import type { ReplayUnitSpan } from '@server/services/SocketService/handlers/chatPhases/replayAssembly';
import {
  applyHistoryFold,
  foldBoundary,
  type HistoryFoldState,
} from '@server/services/contextWindow/historyFold';

const key = (n: number) => ({
  effectiveStart: `t${n}`,
  startAt: `t${n}`,
  sortId: `unit-${n}`,
});
// Units: 1 message, 3 messages (a run with two tool exchanges), 1 message, 2 messages.
const units = (): ReplayUnitSpan[] => [
  { key: key(1), end: 1 },
  { key: key(2), end: 4 },
  { key: key(3), end: 5 },
  { key: key(4), end: 7 },
];
const messages = (): ProviderMessage[] =>
  Array.from({ length: 7 }, (_, i) => ({ role: 'user', content: `m${i}` }) as ProviderMessage);

describe('foldBoundary', () => {
  it('folds whole units up to the split, never into one', () => {
    expect(foldBoundary(units(), 5)).toEqual({ unitCount: 3, endIndex: 5 });
    // Split in the middle of unit 2's run: only unit 1 may fold.
    expect(foldBoundary(units(), 3)).toEqual({ unitCount: 1, endIndex: 1 });
    expect(foldBoundary(units(), 4)).toEqual({ unitCount: 2, endIndex: 4 });
  });

  it('has nothing to fold when the split falls inside the first unit', () => {
    expect(foldBoundary([{ key: key(1), end: 3 }], 2)).toBeNull();
    expect(foldBoundary([], 5)).toBeNull();
    expect(foldBoundary(units(), 0)).toBeNull();
  });
});

describe('applyHistoryFold', () => {
  it('replaces the folded messages with the summary message and shifts the spans', () => {
    const state: HistoryFoldState = { units: units(), compaction: null };
    const list = messages();
    const summary = { role: 'user', content: 'SUMMARY' } as ProviderMessage;

    applyHistoryFold(list, state, { unitCount: 2, endIndex: 4 }, summary);

    expect(list.map((m) => m.content)).toEqual(['SUMMARY', 'm4', 'm5', 'm6']);
    expect(state.units.map((u) => [u.key.sortId, u.end])).toEqual([
      ['unit-3', 2],
      ['unit-4', 4],
    ]);
  });

  it('a second fold replaces the first fold’s summary message too', () => {
    const state: HistoryFoldState = { units: units(), compaction: null };
    const list = messages();
    applyHistoryFold(list, state, { unitCount: 1, endIndex: 1 }, {
      role: 'user',
      content: 'S1',
    } as ProviderMessage);
    // Now [S1, m1, m2, m3, m4, m5, m6] with spans ending 1(+summary), 3, 4, 6.
    expect(list.map((m) => m.content)).toEqual(['S1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(state.units.map((u) => u.end)).toEqual([4, 5, 7]);

    applyHistoryFold(list, state, { unitCount: 1, endIndex: 4 }, {
      role: 'user',
      content: 'S2',
    } as ProviderMessage);
    expect(list.map((m) => m.content)).toEqual(['S2', 'm4', 'm5', 'm6']);
    expect(state.units.map((u) => [u.key.sortId, u.end])).toEqual([
      ['unit-3', 2],
      ['unit-4', 4],
    ]);
  });
});
