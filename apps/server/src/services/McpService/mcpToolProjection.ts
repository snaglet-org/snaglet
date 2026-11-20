/**
 * mcpToolProjection — turns a connected server's raw `listTools()` payload into
 * the cached `McpToolDef[]` McpService exposes, including Snaglet-side description
 * augmentations. Pure functions (no I/O, no connection state) so the projection
 * step can be unit-tested in isolation from a live MCP client/transport.
 */

import { MCP_PREFIX, type McpToolDef } from './mcpTypes';

/**
 * Snaglet-side description augmentations for specific live MCP tools — appended to
 * whatever the upstream server itself reports, never replacing it and never
 * touching the external server. Keyed by `serverId` then `rawToolName`.
 *
 * Currently empty.
 */
const MCP_DESCRIPTION_AUGMENTATIONS: Record<string, Record<string, string>> = {};

/** Exported for unit testing — see McpService.descriptionAugmentation.test.ts. */
export function augmentMcpDescription(
  serverId: string,
  rawToolName: string,
  description: string
): string {
  const extra = MCP_DESCRIPTION_AUGMENTATIONS[serverId]?.[rawToolName];
  return extra ? `${description}${extra}` : description;
}

/** The raw tool shape a server reports from `listTools()`. */
export interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Project a connected server's raw tools into cached `McpToolDef`s: namespace
 * the id (`mcp__<serverId>__<rawToolName>`), augment the description, and default
 * a missing schema to an empty object schema.
 */
export function buildToolDefs(serverId: string, rawTools: RawMcpTool[]): McpToolDef[] {
  return rawTools.map((t) => ({
    serverId,
    namespacedId: `${MCP_PREFIX}${serverId}__${t.name}`,
    rawToolName: t.name,
    name: t.name,
    description: augmentMcpDescription(serverId, t.name, t.description ?? ''),
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
  }));
}
