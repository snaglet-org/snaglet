import { useEffect, useState } from 'react';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { toolsApi } from '@desktop/utils/api';
import { onMcpConnectionEvent } from '@desktop/utils/mcpConnectionEvents';
import type { ToolOption } from '@desktop/components/ToolAccessEditor';

/**
 * Load the tool options a ToolAccessEditor lists — native builtins AND live MCP
 * server tools, sorted for display. Shared by every surface that edits tool
 * access (the agent detail page and the per-thread agent override panel) so the
 * fetch/sort/map is defined once.
 *
 * Refetches on `servers-changed` (MCP connection bus): the agent pane hosting
 * the editor stays mounted while the user adds/removes an MCP server in the
 * sidebar, and that changes which live MCP tools exist. The previous list stays
 * rendered while the refetch is in flight (stale-while-revalidate).
 */
export function useToolOptions(): ToolOption[] {
  const [tools, setTools] = useState<ToolOption[]>([]);
  // Bumped when the MCP server set changes so the fetch effect re-runs.
  const [mcpNonce, setMcpNonce] = useState(0);

  useEffect(
    () =>
      onMcpConnectionEvent((event) => {
        if (event.type === 'servers-changed') setMcpNonce((n) => n + 1);
      }),
    []
  );

  useEffect(() => {
    let canceled = false;
    void toolsApi
      .list({ includeMcp: true })
      .then((rows) => {
        if (canceled) return;
        setTools(
          rows
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
            .map((r) => ({
              id: r.id,
              name: r.name || r.id,
              categoryPath: r.categoryPath,
              description: r.description,
              // Lets the editor show a stored `deny: bash` on shell.
              aliases: r.aliases ?? [],
            }))
        );
      })
      .catch((error: unknown) => {
        // Keep the previously loaded options; a failed refresh must not blank
        // a working editor.
        console.error('[useToolOptions] refreshing tool options failed', error);
      });
    return () => {
      canceled = true;
    };
  }, [mcpNonce]);

  return tools;
}

/** Read an agent's tool-access fields into a normalized ToolAccessConfig. */
export function toolAccessOf(agent: {
  toolAccessMode?: string | null;
  toolAccessAllowList?: unknown;
  toolAccessDenyList?: unknown;
}): ToolAccessConfig {
  return {
    mode: (agent.toolAccessMode as ToolAccessConfig['mode']) ?? 'all',
    allowList: Array.isArray(agent.toolAccessAllowList) ? agent.toolAccessAllowList : [],
    denyList: Array.isArray(agent.toolAccessDenyList) ? agent.toolAccessDenyList : [],
  };
}
