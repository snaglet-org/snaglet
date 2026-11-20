/**
 * mcpTypes — the shared, dependency-light type vocabulary + tuning constants for
 * McpService and its focused helper modules. Pure declarations only (no I/O and
 * no MCP-SDK imports), so every helper seam can share the same shapes without
 * pulling in the connection machinery. SDK-bound connection types
 * (`McpClientTransport`, `McpConnection`) live next to their usage.
 */

import type { McpServerRow } from '@snaglet/db/tables/mcp_servers';

/** Tool-id prefix the model sees, e.g. `mcp__github__create_issue`. */
export const MCP_PREFIX = 'mcp__';

/** Sentinel agent id for tool calls made outside an agent context. */
export const DEFAULT_AGENT_BUCKET = '__default__';
export const IDLE_REAP_MS = 10 * 60 * 1000;
export const REAP_INTERVAL_MS = 60 * 1000;
/** After a failed start, background warm-ups leave the server alone this long. */
export const CONNECT_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/** Internal connection-spec, hydrated from an `mcp_servers` row. */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string | null;
  args: string[];
  url: string | null;
  headers: Record<string, string>;
  env: Record<string, string>;
  scope: 'shared' | 'per-agent';
  /** Global "installed" layer — a disabled server never connects or resolves. */
  enabled: boolean;
  requiresConfirmation: boolean;
  providerId: string | null;
  source: 'builtin' | 'user';
}

/** A live tool exposed by a connected server (cached; never persisted). */
export interface McpToolDef {
  serverId: string;
  /** `mcp__<serverId>__<rawToolName>` — the id the model calls. */
  namespacedId: string;
  rawToolName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: unknown;
  isError?: boolean;
}

export interface McpError {
  error: string;
  server: string;
  detail?: string;
}

/** Map an `mcp_servers` row into the internal connection config. */
export function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: Array.isArray(row.args) ? row.args : [],
    url: row.url,
    headers: row.headers ?? {},
    env: row.env ?? {},
    scope: row.scope,
    enabled: row.enabled,
    requiresConfirmation: row.requiresConfirmation,
    providerId: row.providerId,
    source: row.source,
  };
}
