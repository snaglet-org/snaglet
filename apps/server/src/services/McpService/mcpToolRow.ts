/**
 * mcpToolRow — the ONE projection from a live MCP tool def to the persisted
 * `ToolRow` shape.
 *
 * MCP tools are never written to the `tools` table (they're discovered live and
 * cached). This transient row lets them flow through the same surfaces that
 * consume `ToolRow[]`:
 *   - runtime resolution/dispatch (AgentToolResolver)
 *   - the in-app tool CATALOG the settings/tool-access pane lists
 *
 * Kept pure (type-only imports, no I/O) so it can be shared without pulling the
 * mcp-sdk into consumers that only need the shape.
 *
 * categoryPath is `integrations/<serverId>` — the same convention the sidebar
 * tool tree and the runtime resolver use, so an MCP server groups as its own
 * category alongside the native toolboxes.
 */

import type { ToolRow } from '@snaglet/db/tables/tools';
import type { McpToolDef } from './McpService';

export function mcpToolDefToToolRow(def: McpToolDef): ToolRow {
  return {
    id: def.namespacedId,
    name: def.name,
    description: def.description,
    type: 'mcp',
    parametersSchema: def.inputSchema,
    keywords: [],
    aliases: [],
    source: def.serverId,
    configJson: { serverId: def.serverId, rawToolName: def.rawToolName },
    enabled: true,
    tier: 'standard',
    categoryPath: `integrations/${def.serverId}`,
    providerId: def.serverId,
    sortOrder: 100,
    createdAt: '',
    updatedAt: '',
  };
}
