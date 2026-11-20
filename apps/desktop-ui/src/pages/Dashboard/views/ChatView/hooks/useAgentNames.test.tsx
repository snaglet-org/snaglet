/**
 * useAgentNames: the id → name map behind message authors and status pills.
 * An agent created after the chat opened and then added to the thread still
 * gets a name.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';

const list = vi.hoisted(() => vi.fn());
vi.mock('@desktop/utils/api', () => ({ agentsApi: { list } }));

import { useAgentNames } from './useAgentNames';

const agent = (id: string, name: string) => ({ id, name }) as SnagletAgent;

beforeEach(() => {
  list.mockReset();
});

describe('useAgentNames', () => {
  it('names agents from the whole roster, archived ones included', async () => {
    list.mockResolvedValue([agent('test-agent-a', 'Agent A')]);
    const { result } = renderHook(() => useAgentNames(['test-agent-a']));

    await waitFor(() => expect(result.current.get('test-agent-a')).toBe('Agent A'));
    expect(list).toHaveBeenCalledWith({ includeArchived: true });
  });

  it('reads the roster again when a participant it does not know joins', async () => {
    list.mockResolvedValueOnce([agent('test-agent-a', 'Agent A')]);
    const { result, rerender } = renderHook(({ ids }) => useAgentNames(ids), {
      initialProps: { ids: ['test-agent-a'] },
    });
    await waitFor(() => expect(result.current.get('test-agent-a')).toBe('Agent A'));
    expect(list).toHaveBeenCalledTimes(1);

    list.mockResolvedValueOnce([
      agent('test-agent-a', 'Agent A'),
      agent('test-agent-b', 'Agent B'),
    ]);
    rerender({ ids: ['test-agent-a', 'test-agent-b'] });

    await waitFor(() => expect(result.current.get('test-agent-b')).toBe('Agent B'));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not keep re-reading for a participant the roster never has', async () => {
    list.mockResolvedValue([agent('test-agent-a', 'Agent A')]);
    renderHook(() => useAgentNames(['test-agent-a', 'test-agent-gone']));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('names a subagent helper that is not in the roster, without re-reading for it', async () => {
    list.mockResolvedValue([]);
    const { result } = renderHook(() =>
      useAgentNames(['test-agent-helper'], 'test-agent-helper', 'Scout')
    );

    expect(result.current.get('test-agent-helper')).toBe('Scout');
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(list).toHaveBeenCalledTimes(1);
  });
});
