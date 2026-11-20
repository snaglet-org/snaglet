/**
 * Static, definition-declared tool execution metadata.
 *
 * Declared once in each builtin tool's `definition.ts` (see
 * apps/server/src/services/ToolService/types.ts → ToolDefinition) and exposed
 * verbatim through the tool list/describe API payloads so the panel can drive
 * its run affordances declaratively — no hardcoded tool-name lists in the UI.
 *
 * This is INTRINSIC metadata ("what kind of tool is this"), distinct from the
 * per-(agent, tool) runtime `requiresConfirmation` override in
 * `agent.configJson.toolOverrides` (see ToolOverride in ./config) which is
 * user-configurable policy for the agent dispatch loop.
 */

/** How a tool's handler relates to agent execution context (`ctx.agentId`). */
export type ToolContextRequirement =
  /** Handler is useless or throws without an agent identity (e.g. memory_*). */
  | 'agent-required'
  /** Handler works without an agent but scopes/attributes better with one. */
  | 'agent-optional'
  /** Handler never reads agent context. The default when undeclared. */
  | 'none';

export interface ToolExecutionMetadata {
  /**
   * Drives the panel's act-as-agent picker: 'agent-required' makes the picker
   * mandatory before Run; 'agent-optional' offers it; absent/'none' hides it.
   */
  contextRequirement?: ToolContextRequirement;
  /**
   * Irreversible or externally-visible side effects (raw SQL, hard deletes,
   * outbound messages, pushes to shared remotes). The panel interposes a
   * client-side confirm step before running these. The server does not
   * enforce it on /api/tools/execute: it is advisory metadata for user-driven
   * surfaces.
   */
  destructive?: boolean;
  /**
   * Per-op destructiveness for a merged `op`-enum tool. Declared INSTEAD of
   * `destructive: true` (the registry audit rejects `destructive` on an op-enum
   * tool without this list). The guarded creation-time confirmation default and
   * the panel's confirm strip then cover only these ops.
   */
  destructiveOps?: string[];
  /**
   * String args the approval prompt shows in full and verbatim, with their
   * length, instead of inside the capped JSON summary: for a tool whose call
   * the person must read whole before it runs (workspace_instructions text).
   */
  confirmFullArgs?: string[];
  /**
   * Tool only functions inside the live socket dispatch loop — either the
   * dispatcher intercepts it (`action`'s gateway unwrapping) or it needs a
   * capability only that loop injects (`get_clarification`'s
   * requestClarification callback). The panel hides Run for these and
   * /api/tools/execute rejects them outright.
   */
  dispatchOnly?: boolean;
}
