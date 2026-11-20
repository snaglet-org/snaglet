/**
 * In a helper's own thread the composer's Stop (and the helper's status
 * bubble Stop) pauses the helper instead of only aborting its run.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSummary } from '@snaglet/shared/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ pause: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, threadsApi: { ...actual.threadsApi, pauseSubagent: api.pause } };
});

import { useHelperStop } from './useHelperStop';
import type { HelperThreadInfo } from './useHelperThread';

const SUBAGENT: SubagentSummary = {
  id: 'subagent-1',
  name: 'Scout',
  parentThreadId: 'thread-parent-1',
  threadId: 'thread-helper-1',
  orchestratorAgentId: 'test-agent-a',
  orchestratorName: 'Agent A',
  agentId: 'test-agent-helper-1',
  providerId: 'provider-1',
  modelId: 'model-small',
  status: 'running',
  error: null,
  resumeAt: null,
  taskCount: 1,
  createdAt: '2026-10-12T11:58:00.000Z',
  lastTaskAt: '2026-10-12T11:58:00.000Z',
  finishedAt: null,
};

function helper(subagent: SubagentSummary | null): HelperThreadInfo {
  return { parentThreadId: 'thread-parent-1', title: 'Agent A › Scout', subagent, removed: false };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useHelperStop', () => {
  it("pauses the helper from its thread's Stop and its own status bubble", () => {
    api.pause.mockResolvedValue({ subagent: null, done: true });
    const stop = vi.fn();
    const stopAgent = vi.fn();
    const { result } = renderHook(() => useHelperStop(helper(SUBAGENT), stop, stopAgent));

    result.current.onStop();
    result.current.onStopAgent('test-agent-helper-1');
    expect(api.pause.mock.calls).toEqual([
      ['thread-parent-1', 'subagent-1', {}],
      ['thread-parent-1', 'subagent-1', {}],
    ]);
    expect(stop).not.toHaveBeenCalled();
    expect(stopAgent).not.toHaveBeenCalled();

    // Any other agent's bubble still just stops that agent.
    result.current.onStopAgent('test-agent-b');
    expect(stopAgent).toHaveBeenCalledWith('test-agent-b');
  });

  it('stops as usual in an ordinary thread, or before the helper row loads', () => {
    const stop = vi.fn();
    const stopAgent = vi.fn();
    const ordinary = renderHook(() => useHelperStop(null, stop, stopAgent));
    ordinary.result.current.onStop();
    ordinary.result.current.onStopAgent('test-agent-a');
    const loading = renderHook(() => useHelperStop(helper(null), stop, stopAgent));
    loading.result.current.onStop();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stopAgent).toHaveBeenCalledWith('test-agent-a');
    expect(api.pause).not.toHaveBeenCalled();
  });
});
