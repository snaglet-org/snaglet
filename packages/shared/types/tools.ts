/**
 * Tools table row + input shapes — shared db↔wire schema.
 *
 * `ToolRow` is the persisted `tools` row (packages/db ToolModel) and, spread
 * verbatim, the base of every tool API payload. The list, get, enable and
 * tool-workspace create/save/deploy routes decorate it at read time with
 * `availability` (see ToolAvailability) and the static ToolExecutionMetadata
 * fields (./tool-metadata.ts); POST /api/tools and PUT /api/tools/:id return
 * the bare row. The desktop UI's decorated view extends this shape.
 */

export type ToolTier = 'core' | 'standard';

export interface ToolRow {
  id: string;
  name: string;
  description: string;
  type: 'builtin' | 'mcp' | 'external';
  parametersSchema: Record<string, unknown>;
  keywords: string[];
  aliases: string[];
  source: string | null;
  configJson: Record<string, unknown>;
  /**
   * Admin policy — admin UI writes via PATCH /api/tools/:id/enabled.
   * Survives MCP reconnects. The only durable visibility flag on a tool
   * row; runtime integration availability is derived separately.
   */
  enabled: boolean;
  tier: ToolTier;
  categoryPath: string;
  providerId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateToolInput {
  id: string;
  name: string;
  description?: string;
  type: 'builtin' | 'mcp' | 'external';
  parametersSchema?: Record<string, unknown>;
  keywords?: string[];
  aliases?: string[];
  source?: string | null;
  configJson?: Record<string, unknown>;
  /** Admin policy. Defaults to true on insert; on conflict, existing value preserved. */
  enabled?: boolean;
  tier?: ToolTier;
  categoryPath?: string;
  providerId?: string | null;
  sortOrder?: number;
}

export interface UpdateToolInput {
  name?: string;
  description?: string;
  parametersSchema?: Record<string, unknown>;
  keywords?: string[];
  aliases?: string[];
  source?: string | null;
  configJson?: Record<string, unknown>;
  enabled?: boolean;
  tier?: ToolTier;
  categoryPath?: string;
  providerId?: string | null;
  sortOrder?: number;
}

/**
 * Read-time reachability of a persisted tool (never stored on the row).
 * Derived from `enabled` + the tool's integration provider credential state —
 * see apps/server/src/services/ToolAvailabilityService.ts, the emit site.
 */
export type ToolAvailability =
  | 'available'
  | 'disabled'
  | 'integration_disabled'
  | 'missing_credential'
  | 'unsupported_platform';
