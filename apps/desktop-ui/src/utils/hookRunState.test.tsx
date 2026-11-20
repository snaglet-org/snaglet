import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookRunRecord } from '@snaglet/shared/types';
import { invalidateHookRuns, seedHookRuns, useHookRuns, useHookRunsRevision } from './hookRunState';

const run = (id: string, hookName: string): HookRunRecord => ({
  id,
  hookName,
  source: 'event',
  eventName: 'message:create',
  status: 'succeeded',
  agentId: null,
  threadId: null,
  durationMs: 1,
  exitCode: 0,
  stdout: '',
  stderr: '',
  startedAt: '2026-08-01T00:00:00.000Z',
  finishedAt: '2026-08-01T00:00:00.001Z',
});

afterEach(() => seedHookRuns([]));

describe('hookRunState invalidation', () => {
  it('evicts only affected global rows and bumps that hook detail revision', () => {
    seedHookRuns([run('run-a', 'alpha'), run('run-b', 'beta')]);
    const recent = renderHook(() => useHookRuns());
    const alphaRevision = renderHook(() => useHookRunsRevision('alpha'));
    const betaRevision = renderHook(() => useHookRunsRevision('beta'));
    const beforeAlpha = alphaRevision.result.current;
    const beforeBeta = betaRevision.result.current;

    act(() => invalidateHookRuns(['alpha']));

    expect(recent.result.current.map((item) => item.id)).toEqual(['run-b']);
    expect(alphaRevision.result.current).toBe(beforeAlpha + 1);
    expect(betaRevision.result.current).toBe(beforeBeta);
  });
});
