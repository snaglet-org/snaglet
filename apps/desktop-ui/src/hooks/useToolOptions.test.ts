import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitMcpConnectionEvent } from '@desktop/utils/mcpConnectionEvents';
import { useToolOptions } from './useToolOptions';

const api = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  toolsApi: { list: api.list },
}));

const tool = (id: string, sortOrder = 0) =>
  ({ id, name: id, sortOrder, categoryPath: [], description: null }) as never;

describe('useToolOptions', () => {
  beforeEach(() => {
    api.list.mockReset();
    api.list.mockResolvedValue([tool('shell')]);
  });

  it('refetches when the MCP server set changes while mounted', async () => {
    const hook = renderHook(() => useToolOptions());
    await waitFor(() => expect(hook.result.current).toHaveLength(1));

    // Connecting an MCP server in the sidebar adds live MCP tools. The agent
    // pane hosting the ToolAccessEditor stays mounted, so the option list
    // must refetch off the servers-changed signal rather than a remount.
    api.list.mockResolvedValue([tool('shell'), tool('github_search', 1)]);
    emitMcpConnectionEvent({ type: 'servers-changed' });
    await waitFor(() => expect(hook.result.current).toHaveLength(2));
    expect(api.list).toHaveBeenCalledWith({ includeMcp: true });
  });

  it("passes each tool's definition names through for the editor", async () => {
    api.list.mockResolvedValue([{ ...(tool('shell') as object), aliases: ['bash'] }]);
    const hook = renderHook(() => useToolOptions());
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(hook.result.current[0]?.aliases).toEqual(['bash']);
  });

  it('keeps the loaded options when a refetch fails', async () => {
    const hook = renderHook(() => useToolOptions());
    await waitFor(() => expect(hook.result.current).toHaveLength(1));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.list.mockRejectedValue(new Error('server down'));
    emitMcpConnectionEvent({ type: 'servers-changed' });
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(hook.result.current).toHaveLength(1);
    consoleError.mockRestore();
  });
});
