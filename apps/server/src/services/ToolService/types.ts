/**
 * Tool handler types — shared across ToolService handlers and per-tool entrypoints.
 */

import type {
  ClarificationRequest,
  ClarificationResult,
  ToolExecutionMetadata,
  UnattendedWake,
  WakeOrigin,
} from '@snaglet/shared/types';

/** Runtime info about the agent's provider/model — resolved by the server before tool execution. */
interface ToolRuntimeContext {
  provider: string;
  modelId: string;
  credentialId: string | null;
  agentName: string;
  /** The decrypted API key for the agent's provider. Tools that call external APIs use this. */
  apiKey: string | null;
  /** Human-readable model name for logging/telemetry. Optional. */
  modelName?: string | null;
}

/** Context passed to tool handlers for agent/thread awareness. */
export interface ToolHandlerContext {
  agentId?: string;
  threadId?: string;
  /**
   * Human panel execution may borrow an agent's runtime context without
   * inheriting that agent's tool-access policy. Used only by the executor's
   * action gateway target lookup.
   */
  bypassToolAccess?: boolean;
  /** User message ID that triggered the current run (when available). */
  triggerMessageId?: string;
  hookOrigin?: { kind: 'hook'; hookName: string };
  /**
   * The hook runs as the agent a person set for it (run as), so `agentId` is
   * that agent by a person's choice, not the event's agent. What it posts says
   * so (`[hook <name> as <Agent>]`).
   */
  hookRunAs?: boolean;
  /**
   * A hook call's run thread (its event's), signed into the child's token:
   * whose per-agent "ask first" settings the call is checked against. Not
   * `threadId`: a hook call has no thread of its own to default to.
   */
  hookThreadId?: string;
  /**
   * Set for a hook or workspace-tool child calling back through
   * `/api/tools/execute` (the SDK). A handler that can also returns its data
   * structured, as `rawContent` beside the unchanged text (the `table` read
   * gives `{ rows, fields }`, which `snaglet.tables.read` hands to hook code).
   * Chat never sets it, so a model only ever sees the text.
   */
  structuredResult?: boolean;
  /**
   * Set when the run was started by an automation, not a message. The
   * `automation` tool refuses every write from such a run.
   */
  wakeOrigin?: WakeOrigin;
  /**
   * Set when the run is unattended (an automation or a hook started it, or it
   * runs downstream of one). Nobody can answer: `ask` fails at once.
   */
  unattended?: UnattendedWake;
  /** Runtime model/provider info — set by the server during the active turn. */
  runtime?: ToolRuntimeContext;
  /**
   * Default working directory for filesystem/shell operations.
   *
   * Resolution waterfall (highest priority first):
   *   1. Project `folder_path` — if the thread is inside a project that has one
   *   2. `SNAGLET_AGENT_HOME` env var — user-configurable override
   *   3. `~/.snaglet` — ultimate fallback
   *
   * Individual tools may still accept an explicit `cwd` / `path` param from
   * the agent, which should take precedence over this context default.
   */
  cwd?: string;
  /**
   * Ask the user interactive clarifying questions and BLOCK the run until they
   * answer (or it times out). Injected by the socket dispatch layer during a
   * live turn; absent for headless (non-socket) runs (no user to answer). Only
   * the in-process `get_clarification` builtin uses this.
   */
  requestClarification?: (request: ClarificationRequest) => Promise<ClarificationResult>;
  /**
   * The run's AbortSignal (guardrail-3): fires on socket:chat:abort so an
   * in-flight tool execution is cut short instead of the abort only landing
   * between iterations. The executor races every execution against it; tools
   * that own child processes / HTTP calls should also wire it through.
   */
  signal?: AbortSignal;
}

/** Standard handler signature for all built-in tools. */
/** Rich return from a tool handler — output is the text the model sees, rawContent preserves structured data (e.g. MCP image blocks). */
export interface ToolHandlerRichResult {
  output: string;
  rawContent?: unknown;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  settings: Record<string, unknown>,
  context?: ToolHandlerContext
) => Promise<string | ToolHandlerRichResult>;

/**
 * Static metadata for a tool — loaded from definition.ts files.
 *
 * Extends ToolExecutionMetadata (@snaglet/shared/types/tool-metadata): the
 * optional `contextRequirement` / `destructive` / `dispatchOnly` fields are
 * declared here per tool and surfaced through the tool list/describe API so
 * user-driven surfaces (the panel's ToolView) behave declaratively. The
 * registry audit (scripts/audit-tool-registry.ts) validates their values.
 */
export interface ToolDefinition extends ToolExecutionMetadata {
  id: string;
  name: string;
  description: string;
  type: 'builtin' | 'mcp' | 'external';
  /** Slash-delimited navigation category. Builtins derive this from their folder path. */
  categoryPath: string;
  /** Integration provider whose availability gates this tool, when applicable. */
  providerId?: string;
  tier: 'core' | 'standard';
  keywords: string[];
  aliases?: string[];
  parameters_schema: Record<string, unknown>;
  source?: string;
  sort_order?: number;
  /**
   * Alias-normalization map for this tool's input. Keys are the internal
   * parameter name the handler (`tool.ts`) actually reads today; values are
   * agent-facing name(s) that should be treated as equivalent when the
   * internal key is missing from the call — typically the standardized
   * `id`, occasionally an older still-supported name.
   *
   * Applied once, at the `ToolExecutor` chokepoint (see
   * `lib/normalizeToolParams.ts`), before the handler runs. Handler code and
   * internal variable names are never touched. Kept separate from
   * `parameters_schema` on purpose: alias names are server-side plumbing
   * only and are never rendered into the agent-facing schema (or the MCP
   * projection, which serves `parameters_schema` verbatim).
   *
   * Example: `get_doc`'s handler reads `doc_id`, but the schema advertises
   * the canonical `id` — `param_aliases: { doc_id: ['id'] }` makes both work.
   */
  param_aliases?: Record<string, string[]>;
  /**
   * Fields the handler still accepts but that are left out of
   * `parameters_schema` to save bytes on every turn. Never synced to the
   * DB, never sent to a provider and never in the MCP projection; returned by
   * `tool(op:schema)` as `unlisted_parameters` so an agent that needs one can
   * find its exact name and meaning. Also documented in the tool's TOOL.md.
   */
  unlisted_params?: Record<string, Record<string, unknown>>;
}

/** Source-file shape for builtins before the loader injects the folder-derived category. */
export type BuiltinToolDefinition = Omit<ToolDefinition, 'categoryPath'> & {
  categoryPath?: string;
};
