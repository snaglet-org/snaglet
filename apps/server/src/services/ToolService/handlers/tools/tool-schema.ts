import { Tools } from '@snaglet/db';
import { resolveToolId, toSnakeCase } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { mcpService } from '@server/services/McpService';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';

const tool: ToolHandler = async (input) => {
  // `name` is canonical; `tool` is the get_tool_schema alias spelling.
  const requested = input.name ?? input.tool;
  const raw = requested ? String(requested).trim() : '';
  if (!raw) {
    return JSON.stringify({ error: "Missing required parameter: 'name' (tool id or name)" });
  }

  // MCP tools are live (not DB rows) — resolve their schema from the gateway.
  if (mcpService.isMcpToolId(raw)) {
    const def = mcpService.getToolDef(raw);
    if (!def) {
      return JSON.stringify({
        error: `MCP tool '${raw}' is not available (its server may be disconnected or not enabled for this agent).`,
      });
    }
    return JSON.stringify({
      id: def.namespacedId,
      name: def.name,
      description: def.description,
      category_path: `integrations/${def.serverId}`,
      provider_id: def.serverId,
      tier: 'standard',
      keywords: [],
      aliases: [],
      parameters_schema: def.inputSchema ?? {},
      call_with: callWith(def.namespacedId),
    });
  }

  // 1. exact id match
  let row = await Tools.findById(raw);

  // 2. alias match (lowercased — aliases are stored lowercase)
  if (!row) {
    row = await Tools.findByAlias(raw.toLowerCase());
  }

  // 3. display-name match (case-insensitive)
  if (!row) {
    const byName = await Tools.query<{ id: string }>(
      `SELECT id FROM tools WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [raw]
    );
    if (byName.length > 0) row = await Tools.findById(byName[0].id);
  }

  // Permanent catalog aliases apply only after the exact row, definition
  // alias, and display name have all missed.
  if (!row) {
    const resolution = resolveToolId(toSnakeCase(raw));
    if (resolution.removed) {
      return JSON.stringify({ error: resolution.removed });
    }
    if (resolution.aliasedFrom) row = await Tools.findById(resolution.id);
  }

  if (!row) {
    return JSON.stringify({
      error: `No tool found matching '${raw}'. Try tool(op:search) to discover candidates.`,
    });
  }

  // A disabled row (folder removed, or admin-disabled) has no callable
  // handler behind it. Serving its schema would invite a
  // call that can only fail, so treat it like tool(op:search) does (its channels
  // all gate on enabled=TRUE) and keep the two discovery surfaces consistent.
  if (!row.enabled) {
    return JSON.stringify({
      error:
        `Tool '${row.id}' is disabled or retired and cannot be called. ` +
        `Use tool(op:search) to find a current alternative.`,
    });
  }

  return JSON.stringify({
    id: row.id,
    name: row.name,
    description: row.description,
    category_path: row.categoryPath,
    provider_id: row.providerId,
    tier: row.tier,
    keywords: row.keywords ?? [],
    aliases: row.aliases ?? [],
    parameters_schema: row.parametersSchema ?? {},
    // Accepted but not advertised: read from the loaded definition, not
    // the DB row, so they never reach the wire schema.
    ...unlistedParameters(row.id),
    call_with: callWith(row.id),
  });
};

// Fetching a schema never adds the tool to the advertised set (that would
// rewrite the run's cached prompt), so the result says how to reach it.
function callWith(toolId: string): string {
  return `action({tool: ${JSON.stringify(toolId)}, params: {...}})`;
}

function unlistedParameters(toolId: string): { unlisted_parameters?: Record<string, unknown> } {
  const unlisted = toolRegistry.getDefinition(toolId)?.unlisted_params;
  if (!unlisted || Object.keys(unlisted).length === 0) return {};
  return { unlisted_parameters: unlisted };
}

export default tool;
