/**
 * fallbackPolicy + cacheFootprintTracker unit tests.
 */

import { decideFallback } from '@server/services/SocketService/handlers/chatPhases/fallbackPolicy';
import {
  estimateAbandonedCacheTokens,
  recordCacheFootprint,
} from '@server/services/SocketService/handlers/chatPhases/cacheFootprintTracker';

describe('decideFallback', () => {
  test('falls back when a next model exists and nothing forbids it', () => {
    expect(
      decideFallback({ hasNextModel: true, userPinnedModel: false, fallbackDisabled: false })
    ).toEqual({ fallback: true });
  });

  test('a user-pinned model never falls back (highest precedence)', () => {
    expect(
      decideFallback({ hasNextModel: true, userPinnedModel: true, fallbackDisabled: false })
    ).toEqual({ fallback: false, reason: 'pinned' });
    // pinned wins even when fallback is also disabled
    expect(
      decideFallback({ hasNextModel: true, userPinnedModel: true, fallbackDisabled: true })
    ).toEqual({ fallback: false, reason: 'pinned' });
  });

  test('disableModelFallback blocks the retry even with candidates left', () => {
    expect(
      decideFallback({ hasNextModel: true, userPinnedModel: false, fallbackDisabled: true })
    ).toEqual({ fallback: false, reason: 'disabled' });
  });

  test('an exhausted chain stops', () => {
    expect(
      decideFallback({ hasNextModel: false, userPinnedModel: false, fallbackDisabled: false })
    ).toEqual({ fallback: false, reason: 'exhausted' });
  });
});

describe('cacheFootprintTracker', () => {
  test('records read + creation as the abandoned-cache estimate', () => {
    recordCacheFootprint('t1', 'a1', { cacheReadTokens: 8000, cacheCreationTokens: 500 });
    expect(estimateAbandonedCacheTokens('t1', 'a1')).toBe(8500);
  });

  test('latest footprint wins', () => {
    recordCacheFootprint('t2', 'a1', { cacheReadTokens: 100, cacheCreationTokens: 0 });
    recordCacheFootprint('t2', 'a1', { cacheReadTokens: 9000, cacheCreationTokens: 250 });
    expect(estimateAbandonedCacheTokens('t2', 'a1')).toBe(9250);
  });

  test('zero/absent usage does not clobber the previous footprint', () => {
    recordCacheFootprint('t3', 'a1', { cacheReadTokens: 5000 });
    recordCacheFootprint('t3', 'a1', undefined);
    recordCacheFootprint('t3', 'a1', { cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(estimateAbandonedCacheTokens('t3', 'a1')).toBe(5000);
  });

  test('unknown (thread, agent) estimates zero', () => {
    expect(estimateAbandonedCacheTokens('never-seen', 'nope')).toBe(0);
  });
});
