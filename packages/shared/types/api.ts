/**
 * API contract types shared between frontend and backend
 */

import type { CursorSpec } from '../cursor/types';

/**
 * Core agent domain node returned from the agents API.
 */
export interface SnagletAgent {
  id: string;
  name: string;
  role?: string;
  avatarUrl?: string;
  credentialId?: string | null;
  modelId?: string | null;
  /** Expanded/resolved identity (wiki-links replaced with content). */
  identity?: string | null;
  /**
   * Raw stored identity — may carry wiki-link refs like `![Name](doc-id)`.
   * Used by the editor: the expanded `identity` contains literal
   * `<doc id=…>…</doc>` wrappers the rich editor can't render (it would show
   * them as raw text), exactly like `rawSystemPrompt` vs `systemPrompt`.
   */
  rawIdentity?: string | null;
  provider: string;
  /** Expanded/resolved system prompt (wiki-links replaced with content). */
  systemPrompt: string;
  /** Raw stored value — may be a wiki-link ref like `![Name](doc-id)`. Used by the editor. */
  rawSystemPrompt: string | null;
  toolAccessMode: string | null;
  toolAccessAllowList: string[] | null;
  toolAccessDenyList: string[] | null;
  /**
   * Opt-in strict advertisement (default false). Only meaningful when
   * `toolAccessMode` is `'allow_list'`: the tool catalog ADVERTISED to the
   * model becomes exactly the allow list intersected with the tools the agent
   * could actually reach, plus the `tool`
   * discovery riders — those ride along even when not listed so a trimmed
   * agent can still discover and request other tools (a rider that is
   * access-gated for the agent does not ride along). Inert in other modes.
   * Trims advertisement only; callability and ask-escalation are unchanged.
   * Intended for small-context models that can't afford the full core catalog.
   */
  toolAccessAdvertiseAllowedOnly?: boolean;
  /** Whether other parties may DM this agent (agents.dm_enabled); absent reads as on. */
  dmEnabled?: boolean;
  /** MCP server ids enabled for this agent (per-agent enablement; live tools). */
  mcpServers: string[] | null;
  toolOverrides: Record<string, unknown> | null;
  /**
   * Trusted tool calls (default false): permitted native AND MCP tool calls
   * run without the approval prompt. Bypasses confirmation only — access
   * (allow/deny lists, MCP server enablement, thread restrictions) is
   * unchanged, and an explicit thread-level `requiresConfirmation` still
   * wins. Precedence: thread override > agent trust > agent per-tool
   * override > tool/MCP-server default.
   */
  trustedToolCalls?: boolean;
  /** Per-turn tool-call ceiling default. Null = fall through to the global setting. */
  maxToolCallsPerTurn: number | null;
  /** Wall-clock ceiling for one turn, in seconds. Null = no agent-level limit. */
  maxDurationSeconds: number | null;
  fallbacks: Array<Record<string, unknown>> | null;
  disableModelFallback: boolean;
  /** Per-agent TTS voice id for voice mode; null → deterministic default voice. */
  voice?: string | null;
  /** Agent cursor flower id (see CURSOR_FLOWERS); null/absent → per-agent default. */
  cursorFlower?: string | null;
  /** Agent cursor #rrggbb tint; null/absent → the flower's default color. */
  cursorColor?: string | null;
  /** Generated flower-with-a-face spec (theme-token colors); null/absent → derived from the agent id. */
  cursorSpec?: CursorSpec | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Archive state from the parent nodes row. Listings filter on this by
   * default; per-id lookups still return archived rows so historical
   * attribution and explicit "agent archived" branches can read it.
   */
  archived: boolean;
  archivedAt: string | null;
  /**
   * Tombstone marker. Non-null once the agent has been permanently swept
   * from the ArchivedDrawer: its memories / thread summaries are destroyed and
   * its config cleared, but the row survives as a name-only husk so past
   * messages stay attributed. A tombstone is always archived too and is hidden
   * everywhere except name-attribution lookups.
   */
  deletedAt?: string | null;
  /**
   * Set on a subagent helper: the orchestrator agent that started it.
   * Helpers are left out of agent listings and reached by id only.
   */
  parentAgentId?: string | null;
}

/**
 * Standard health check response format
 */
export interface HealthResponse {
  status: string;
  timestamp: string;
  message: string;
}

/**
 * Standard API error response format
 */
export interface ApiError {
  error: string;
  message: string;
  timestamp: string;
  status: number;
}

/**
 * Successful API response envelope. `success: true` is the discriminant —
 * narrowing on it guarantees `data` is present and typed as T.
 */
export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  timestamp: string;
}

/**
 * Failed API response envelope. `success: false` is the discriminant.
 *
 * This is the shape `sendFailure` (apps/server/src/utils/http.ts) actually
 * puts on the wire for route-level failures. Note: uncaught errors and
 * unmatched routes go through the global error middleware instead, which
 * emits the nested `ErrorResponse` shape (`error: { code, message }` — see
 * ./error.ts) with no timestamp; clients that parse failure bodies off the
 * raw wire must tolerate both.
 */
export interface ApiFailure {
  success: false;
  error: string;
  details?: unknown;
  timestamp: string;
}

/**
 * Base API response wrapper for consistent response formatting.
 *
 * Discriminated union: switch on `.success` to narrow. This is the single
 * canonical envelope shape — the server's `sendOk`/`sendCreated` produce the
 * `ApiSuccess` variant, and clients must import this type rather than
 * re-declaring a `success: boolean` copy (which defeats union narrowing).
 */
export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiFailure;

/**
 * Gateway status response
 */
export interface GatewayStatus {
  running: boolean;
  pid: string | null;
  port: number;
  logFile: string | null;
}

/**
 * Gateway action response (start/stop)
 */
export interface GatewayActionResponse {
  success: boolean;
  message: string;
  pid?: string | null;
}

/**
 * Combined server status — GET /api/server/status
 */
export interface ServerStatusResponse {
  status: 'healthy' | 'error';
  port: number;
  uptime: {
    seconds: number;
    human: string;
  };
  memory: {
    heapUsed: string;
    heapTotal: string;
    rss: string;
  };
  timestamp: string;
}

/**
 * API route constants for consistent endpoint usage
 * Note: In client-side code, use getApiUrl() function to get full URLs
 * Routes are relative to API_BASE_URL (which typically ends in /api)
 */
export const API_ROUTES = {
  HEALTH: '/health',
  SERVER_STATUS: '/server/status',
  SERVER_STOP: '/server/stop',
  SERVER_LOGS: '/server/logs',
  GATEWAY_STATUS: '/gateway/status',
  GATEWAY_START: '/gateway/start',
  GATEWAY_STOP: '/gateway/stop',
  GATEWAY_LOGS: '/gateway/logs',
} as const;

/**
 * One table's size in GET /api/db/stats. `table_name` is bare for `public`
 * tables and `user_tables.<name>` for the physical tables behind custom tables.
 */
export interface DbTableSize {
  table_name: string;
  total_size: string;
  table_size: string;
  indexes_size: string;
}

/** GET /api/db/stats: what Settings → Data → Backups shows about the database. */
export interface DbStatsResponse {
  database_size: string;
  tables: DbTableSize[];
}
