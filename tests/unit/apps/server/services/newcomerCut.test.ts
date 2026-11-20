/**
 * An agent new to a thread never summarizes or borrows a summary: it gets only the newest
 * replay units that fit in a share of its model window, and the units before them are cut.
 */
import { describe, expect, it } from '@jest/globals';
import {
  newcomerTailCap,
  planNewcomerCut,
} from '@server/services/SocketService/handlers/chatPhases/newcomerCut';
import type {
  ReplayUnitSpan,
  ReplayUnitKey,
} from '@server/services/SocketService/handlers/chatPhases/replayAssembly';

const key = (n: number): ReplayUnitKey => ({
  effectiveStart: `2026-10-20T10:00:0${n}.000Z`,
  startAt: `2026-10-20T10:00:0${n}.000Z`,
  sortId: `m${n}`,
});

/** Six one-message units of 4,000 chars each: about 1,004 estimated tokens per unit. */
const messages = Array.from({ length: 6 }, () => ({
  role: 'user' as const,
  content: 'x'.repeat(4000),
}));
const units: ReplayUnitSpan[] = messages.map((_, i) => ({ key: key(i + 1), end: i + 1 }));

describe('newcomer cut', () => {
  it('is 30% of the model window', () => {
    expect(newcomerTailCap(200_000)).toBe(60_000);
    expect(newcomerTailCap(8_000)).toBe(2_400);
  });

  it('keeps everything when the whole history fits the cap', () => {
    expect(planNewcomerCut({ messages, units, capTokens: 10_000 })).toBeNull();
  });

  it('cuts the oldest units so the newest ones fit the cap', () => {
    expect(planNewcomerCut({ messages, units, capTokens: 2_400 })).toEqual({
      through: key(4),
      omittedUnits: 4,
    });
  });

  it('always keeps the newest unit, even over the cap', () => {
    expect(planNewcomerCut({ messages, units, capTokens: 10 })).toEqual({
      through: key(5),
      omittedUnits: 5,
    });
  });

  it('cuts nothing on an empty history', () => {
    expect(planNewcomerCut({ messages: [], units: [], capTokens: 10 })).toBeNull();
  });
});
