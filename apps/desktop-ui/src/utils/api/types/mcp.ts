/**
 * Types for upstream MCP server connections (MCP → Server connections).
 *
 * Mirrors the server's `mcp_servers` row plus the live decorations added by
 * GET /api/mcp/servers (status, requiresCredential, credentialSpec,
 * hasCredential, install).
 */

export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpScope = 'shared' | 'per-agent';
type McpSource = 'builtin' | 'user';
/**
 * idle: stopped after 10 minutes without a tool call (its tools stay listed;
 * the next call starts it) · unknown: not started since Snaglet started ·
 * disconnected: a start failed or was skipped (see statusDetail).
 */
type McpStatus = 'connected' | 'disconnected' | 'connecting' | 'idle' | 'unknown';

/** What credential shape a server needs, derived from its env/headers placeholders. */
interface McpCredentialSpec {
  /** Server references `${credential}` — one opaque secret. */
  requiresSecret: boolean;
  /** Server references `${cred.<field>}` — one named bundle field each. */
  bundleFields: string[];
}

/**
 * How an `npx <pkg>` server is installed (null for other servers): Snaglet installs
 * the package once and starts it with node, or runs it through npx (reason).
 */
export interface McpInstallInfo {
  /** installed · pending (installs on its next start) · installing · npx (see reason). */
  state: 'installed' | 'pending' | 'installing' | 'npx';
  packageName: string | null;
  /** Version the command pins; null = latest. */
  requested: string | null;
  installedVersion: string | null;
  installedAt: string | null;
  reason: string | null;
  /** The last install/update error, even while an older copy still runs. */
  lastError: string | null;
  /** Whether Update can install this server's package. */
  updatable: boolean;
}

export interface McpServer {
  id: string;
  providerId: string | null;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  headers: Record<string, string>;
  env: Record<string, string>;
  scope: McpScope;
  enabled: boolean;
  autoload: boolean;
  requiresConfirmation: boolean;
  source: McpSource;
  createdAt: string;
  updatedAt: string;
  // live decorations (read-only)
  status: McpStatus;
  /** Why the last start failed or was skipped; null when it didn't. */
  statusDetail?: string | null;
  requiresCredential: boolean;
  credentialSpec: McpCredentialSpec;
  hasCredential: boolean;
  install?: McpInstallInfo | null;
}

/** Create/edit payload (server fills defaults for omitted optional fields). */
export interface McpServerUpsert {
  id: string;
  name: string;
  transport?: McpTransport;
  providerId?: string | null;
  command?: string | null;
  args?: string[];
  url?: string | null;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  scope?: McpScope;
  enabled?: boolean;
  autoload?: boolean;
  requiresConfirmation?: boolean;
}

/** What Update did: `ok` is the install; `error` also covers a failed restart. */
export interface McpInstallResult {
  ok: boolean;
  previousVersion: string | null;
  installedVersion: string | null;
  /** The server was running and was restarted on the new copy. */
  restarted: boolean;
  error?: string;
  /** The refreshed row. */
  server: McpServer;
}

export interface McpTestResult {
  ok: boolean;
  status: string;
  toolCount: number;
  error?: string;
}

/** Save payload for a server's credential: an opaque secret and/or a field bundle. */
export interface McpCredentialInput {
  secret?: string;
  bundle?: Record<string, string>;
}
