/**
 * hookChainGuard — the gate every hook run passes before it takes a slot.
 * Snaglet does not refuse loops: depth and the chain are recorded but never
 * refuse. These specs pin that a deep
 * chain with repeats is admitted, the per-hook burst window (fake timers) and
 * which runs count toward it, a hook's nested self-run is still refused, and
 * the refusal-row cap with its carried count.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { logger } from '@server/config/logger';
import { settingsService } from '@server/services/settings/settingsService';
import { workerSettings } from '@server/services/settings/categories/workers';
import {
  DEFAULT_HOOK_CHAIN_LIMITS,
  HookChainGuard,
  readHookChainLimits,
  type HookChainRequest,
  type HookChainVerdict,
} from '@server/services/customHooks/hookChainGuard';

const LIMITS = { maxRunsPerMinute: 5 };

const request = (overrides: Partial<HookChainRequest> = {}): HookChainRequest => ({
  hookName: 'test-hook-a',
  source: 'event',
  causeDepth: 0,
  causeChain: [],
  repeatInChain: false,
  nested: false,
  ...overrides,
});

function refused(verdict: HookChainVerdict) {
  if (verdict.allowed) throw new Error('expected a refusal');
  return verdict;
}

describe('hookChainGuard', () => {
  let guard: HookChainGuard;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });
    guard = new HookChainGuard();
  });

  afterEach(() => {
    guard.flush();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('loops are not refused', () => {
    it('a very deep chain still runs, and keeps counting depth', () => {
      // 60 hops, each a repeat of one of two hooks: an A → B → A → B … loop.
      const chain = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 'ping' : 'pong'));
      const verdict = guard.check(
        request({ hookName: 'ping', source: 'event', causeDepth: 60, causeChain: chain }),
        LIMITS
      );
      expect(verdict.allowed).toBe(true);
      // Depth keeps counting past 32, even though the chain list is truncated.
      expect(verdict.depth).toBe(61);
      if (!verdict.allowed) throw new Error('unreachable');
      expect(verdict.chain.length).toBeLessThanOrEqual(32);
      expect(verdict.chain[verdict.chain.length - 1]).toBe('ping');
    });

    it('a hook that already ran in its chain (A → B → A) is admitted', () => {
      const verdict = guard.check(
        request({ causeDepth: 2, causeChain: ['test-hook-a', 'test-hook-b'] }),
        LIMITS
      );
      expect(verdict).toMatchObject({ allowed: true, depth: 3 });
    });

    it('a hook firing on its own write (A → A) is admitted', () => {
      const verdict = guard.check(request({ causeDepth: 1, causeChain: ['test-hook-a'] }), LIMITS);
      expect(verdict).toMatchObject({ allowed: true, depth: 2 });
    });

    it('repeatInChain is accepted as a no-op and changes nothing', () => {
      const off = guard.check(request({ causeDepth: 1, causeChain: ['test-hook-a'] }), LIMITS);
      const on = guard.check(
        request({ causeDepth: 1, causeChain: ['test-hook-a'], repeatInChain: true }),
        LIMITS
      );
      expect(off.allowed).toBe(true);
      expect(on.allowed).toBe(true);
    });
  });

  describe('nested self-run is still refused', () => {
    it('a hook running itself via snaglet.hooks.run while running is refused (even with repeatInChain)', () => {
      const verdict = refused(
        guard.check(
          request({
            source: 'manual',
            causeDepth: 1,
            causeChain: ['test-hook-a'],
            repeatInChain: true,
            nested: true,
          }),
          LIMITS
        )
      );
      expect(verdict.limit).toBe('chain');
      expect(verdict.stderr).toContain("can't run itself");
      expect(verdict.stderr).toContain('Chain: test-hook-a → test-hook-a.');
    });

    it('another hook running it nested is allowed', () => {
      expect(
        guard.check(
          request({
            source: 'manual',
            causeDepth: 2,
            causeChain: ['test-hook-a', 'test-hook-b'],
            nested: true,
          }),
          LIMITS
        ).allowed
      ).toBe(true);
    });
  });

  describe('runs per minute', () => {
    it('stops at the limit and frees up as the rolling minute moves on', () => {
      for (let i = 0; i < 5; i += 1) {
        expect(guard.check(request(), LIMITS).allowed).toBe(true);
        jest.advanceTimersByTime(1_000);
      }
      const sixth = refused(guard.check(request(), LIMITS));
      expect(sixth.limit).toBe('burst');
      expect(sixth.stderr).toBe(
        'Stopped by the runs-per-minute limit: "test-hook-a" already ran 5 times in the last ' +
          'minute (limit: workers.hooks_max_runs_per_minute = 5). Chain: test-hook-a.'
      );
      // Another hook has its own budget.
      expect(guard.check(request({ hookName: 'test-hook-b' }), LIMITS).allowed).toBe(true);
      // The first run leaves the window 60 s after it started.
      jest.advanceTimersByTime(55_000);
      expect(guard.check(request(), LIMITS).allowed).toBe(true);
      expect(guard.check(request(), LIMITS).allowed).toBe(false);
    });

    it('schedules and a person’s own runs do not count; nested and event runs do', () => {
      for (let i = 0; i < 10; i += 1) {
        expect(guard.check(request({ source: 'schedule' }), LIMITS).allowed).toBe(true);
        expect(guard.check(request({ source: 'manual', causeDepth: 0 }), LIMITS).allowed).toBe(
          true
        );
      }
      for (let i = 0; i < 3; i += 1) {
        expect(
          guard.check(
            request({ source: 'manual', causeDepth: 1, causeChain: ['test-hook-b'], nested: true }),
            LIMITS
          ).allowed
        ).toBe(true);
      }
      expect(guard.check(request(), LIMITS).allowed).toBe(true);
      expect(guard.check(request({ causeDepth: 0 }), LIMITS).allowed).toBe(true);
      expect(refused(guard.check(request(), LIMITS)).limit).toBe('burst');
    });

    it('uncount gives an admitted run back (a nested run that then found no slot)', () => {
      const admitted: HookChainVerdict[] = [];
      for (let i = 0; i < 5; i += 1) admitted.push(guard.check(request(), LIMITS));
      expect(guard.check(request(), LIMITS).allowed).toBe(false);
      const last = admitted[4];
      if (!last?.allowed) throw new Error('expected an admission');
      last.uncount();
      expect(guard.check(request(), LIMITS).allowed).toBe(true);
    });
  });

  describe('refusal rows', () => {
    it('one row per hook and limit per minute; the rest are logged when the minute closes and carried into the next row', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      // Exhaust the burst budget first, then every further run is a burst refusal.
      for (let i = 0; i < 5; i += 1) expect(guard.check(request(), LIMITS).allowed).toBe(true);
      const loop = () => refused(guard.check(request(), LIMITS));
      expect(loop().record).toBe(true);
      expect(loop().record).toBe(false);
      expect(loop().record).toBe(false);
      // A different hook's burst refusal gets its own row.
      for (let i = 0; i < 5; i += 1) guard.check(request({ hookName: 'test-hook-b' }), LIMITS);
      expect(refused(guard.check(request({ hookName: 'test-hook-b' }), LIMITS)).record).toBe(true);
      expect(warn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(60_000);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        '"test-hook-a": 2 more runs were stopped by the runs-per-minute limit in the last minute'
      );
    });

    it('flush logs what an open minute counted (shutdown)', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      for (let i = 0; i < 6; i += 1) guard.check(request(), LIMITS);
      guard.check(request(), LIMITS);
      guard.flush();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        '1 more run was stopped by the runs-per-minute limit'
      );
    });
  });
});

describe('readHookChainLimits', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the runs-per-minute setting', async () => {
    jest
      .spyOn(settingsService, 'read')
      .mockImplementation(
        (def) => Promise.resolve(def.key === 'hooks_max_runs_per_minute' ? 50 : 0) as never
      );
    await expect(readHookChainLimits()).resolves.toEqual({ maxRunsPerMinute: 50 });
  });

  it('falls back to the default (600 a minute) when Settings can’t be read', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    jest.spyOn(settingsService, 'read').mockRejectedValue(new Error('db down') as never);
    await expect(readHookChainLimits()).resolves.toEqual(DEFAULT_HOOK_CHAIN_LIMITS);
    expect(DEFAULT_HOOK_CHAIN_LIMITS).toEqual({ maxRunsPerMinute: 600 });
  });
});

describe('chain limit settings', () => {
  it('there is no chain-depth setting', () => {
    expect('hooksMaxChainDepth' in workerSettings).toBe(false);
  });

  it('runs-per-minute validates its range: 1–10000, whole numbers', () => {
    const perMinute = workerSettings.hooksMaxRunsPerMinute;
    expect([perMinute.category, perMinute.key, perMinute.default]).toEqual([
      'workers',
      'hooks_max_runs_per_minute',
      600,
    ]);
    for (const ok of [1, 10_000]) expect(perMinute.schema.safeParse(ok).success).toBe(true);
    for (const bad of [0, 10_001, 1.5]) {
      expect(perMinute.schema.safeParse(bad).success).toBe(false);
    }
  });
});
