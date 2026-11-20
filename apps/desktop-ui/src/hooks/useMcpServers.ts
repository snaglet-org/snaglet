import { useCallback, useEffect, useRef, useState } from 'react';
import { mcpServersApi } from '@desktop/utils/api';
import type { McpServer } from '@desktop/utils/api';
import { onMcpConnectionEvent } from '@desktop/utils/mcpConnectionEvents';

interface McpServersData {
  servers: McpServer[];
  loading: boolean;
}

export interface UseMcpServers extends McpServersData {
  /**
   * Refetch now. For a change this window's MCP pane did not make (another
   * window, an agent's `mcp` tool), which emits no `servers-changed`.
   */
  revalidate: () => void;
}

// Stale-while-revalidate (house pattern, see useModelData in ModelSelector):
// the module cache exists only so a remount renders instantly without a
// loading flash. It is never trusted as current — every mount refetches, and
// a `servers-changed` event on the MCP connection bus refetches while
// mounted. The second path matters most: AgentView (whose MCP section reads
// through here) stays mounted in its pane while the user creates a server in
// the sidebar's MCP view, and re-selecting the same agent never remounts it.
let cachedServers: McpServer[] | null = null;
let fetchPromise: Promise<McpServer[]> | null = null;

function fetchMcpServers(): Promise<McpServer[]> {
  // Concurrent mounts share one in-flight request; a settled cache is only a
  // render seed, never a reason to skip the refetch.
  if (fetchPromise) return fetchPromise;

  fetchPromise = mcpServersApi
    .list()
    .then((list) => {
      cachedServers = list;
      return list;
    })
    .finally(() => {
      fetchPromise = null;
    });

  return fetchPromise;
}

/**
 * The full MCP server list, revalidated on every mount, on every
 * `servers-changed` event and on `revalidate()`. Consumers filter (e.g. to
 * enabled servers) themselves.
 */
export function useMcpServers(): UseMcpServers {
  const [data, setData] = useState<McpServersData>(() =>
    cachedServers ? { servers: cachedServers, loading: false } : { servers: [], loading: true }
  );
  const mountedRef = useRef(false);

  const revalidate = useCallback(() => {
    fetchMcpServers().then(
      (servers) => {
        if (mountedRef.current) setData({ servers, loading: false });
      },
      (error: unknown) => {
        // Keep whatever we rendered from cache; a failed revalidation must
        // not blank a working list or strand a spinner.
        console.error('[useMcpServers] refreshing MCP server list failed', error);
        if (mountedRef.current) setData({ servers: cachedServers ?? [], loading: false });
      }
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    revalidate();
    const off = onMcpConnectionEvent((event) => {
      if (event.type === 'servers-changed') revalidate();
    });
    return () => {
      mountedRef.current = false;
      off();
    };
  }, [revalidate]);

  return { ...data, revalidate };
}
