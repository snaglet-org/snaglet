import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitMcpConnectionEvent } from '@desktop/utils/mcpConnectionEvents';
import { useMcpServers } from './useMcpServers';

const api = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  mcpServersApi: { list: api.list },
}));

const server = (id: string) => ({ id, name: id, enabled: true }) as never;

describe('useMcpServers', () => {
  beforeEach(() => {
    api.list.mockResolvedValue([server('github')]);
  });

  it('revalidates on every mount so servers added in the MCP pane appear', async () => {
    const first = renderHook(() => useMcpServers());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.servers).toHaveLength(1);
    first.unmount();

    // A new MCP server is saved in the sidebar MCP view…
    api.list.mockResolvedValue([server('github'), server('linear')]);

    // …then the user opens an agent's settings: the list must refetch, not
    // serve the session-old cache.
    const second = renderHook(() => useMcpServers());
    // Cached servers render immediately — no loading flash on remount.
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.servers).toHaveLength(1);
    await waitFor(() => expect(second.result.current.servers).toHaveLength(2));
  });

  it('refetches on servers-changed while still mounted (agent pane open during sidebar create)', async () => {
    const hook = renderHook(() => useMcpServers());
    // Let the mount revalidation settle first so the event refetch below is
    // a distinct request (the fetch is single-flighted).
    await waitFor(() => expect(hook.result.current.servers).toHaveLength(1));

    // Creating a server in the sidebar goes through useMcp, which emits
    // servers-changed — this hook must hear it and refetch, because the
    // agent pane hosting it never remounts when re-selecting the same agent.
    api.list.mockResolvedValue([server('github'), server('linear'), server('notion')]);
    emitMcpConnectionEvent({ type: 'servers-changed' });
    await waitFor(() => expect(hook.result.current.servers).toHaveLength(3));
  });

  it('keeps the cached list when a revalidation fails', async () => {
    const seeded = renderHook(() => useMcpServers());
    await waitFor(() => expect(seeded.result.current.loading).toBe(false));
    seeded.unmount();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.list.mockRejectedValue(new Error('server down'));
    const remount = renderHook(() => useMcpServers());
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(remount.result.current.loading).toBe(false);
    expect(remount.result.current.servers.length).toBeGreaterThan(0);
    consoleError.mockRestore();
  });
});
