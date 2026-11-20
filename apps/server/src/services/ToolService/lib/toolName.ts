/**
 * Tool-name validation + sanitization primitives.
 *
 * OpenAI / Copilot (and every OpenAI-compatible chat-completions surface)
 * require `tool_calls[].function.name` and advertised `tools[].function.name`
 * to match `^[a-zA-Z0-9_.-]+$` (max 64 chars). Snaglet tool ids are usually
 * snake_case and safe, but two sources can mint names that violate this:
 *
 *   1. MCP tools — the namespaced id is `mcp__<serverId>__<rawToolName>`, and
 *      neither `serverId` nor the external server's `rawToolName` is
 *      constrained (a space or colon is legal upstream, illegal on the wire).
 *   2. Replayed history — older activity-log rows record action-gateway tool
 *      calls as `action→<id>` (U+2192 RIGHTWARDS ARROW). That string lands in
 *      `agent_activity_log.tool`, is replayed verbatim into a `tool_use.name`,
 *      and fails the entire request (400) on OpenAI/Copilot, poisoning every
 *      subsequent turn on those providers.
 *
 * This module owns the canonical pattern + a single-segment sanitizer. The
 * per-request, collision-aware, round-trippable sanitizer that the wire path
 * needs lives in `ProviderChatService/providers/shared/toolNameSanitizer.ts`
 * and builds on `sanitizeToolNameSegment` here.
 */

/** Function-name grammar accepted by OpenAI-compatible chat-completions. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/**
 * Stricter function-name grammar used by the OpenAI **Responses** wire (Codex's
 * `chatgpt.com/backend-api/codex/responses` and Copilot's `/responses`). That
 * surface rejects dots in a function name (a tool advertised as `get.time`
 * gets a 400), so the dot must be coerced to `_`. Everything else matches the
 * chat-completions grammar.
 */
const TOOL_NAME_PATTERN_NO_DOTS = /^[a-zA-Z0-9_-]+$/;

/** OpenAI's hard cap on a function name. */
export const TOOL_NAME_MAX_LENGTH = 64;

/**
 * A per-wire tool-name grammar. `pattern` validates a whole name; `illegal`
 * matches (globally) the characters that must be coerced to `_` when a name
 * doesn't validate. The two must agree — `illegal` is the complement of the
 * character class inside `pattern`.
 */
export interface ToolNameGrammar {
  pattern: RegExp;
  illegal: RegExp;
}

/** Chat-completions grammar (dots allowed). The default everywhere. */
export const DOTTED_TOOL_NAME_GRAMMAR: ToolNameGrammar = {
  pattern: TOOL_NAME_PATTERN,
  illegal: /[^a-zA-Z0-9_.-]/g,
};

/** Responses-wire grammar (dots coerced to `_`). Used by codex + copilot/responses. */
export const NO_DOTS_TOOL_NAME_GRAMMAR: ToolNameGrammar = {
  pattern: TOOL_NAME_PATTERN_NO_DOTS,
  illegal: /[^a-zA-Z0-9_-]/g,
};

/** True iff `name` is already a legal function name for the given wire grammar. */
export function isValidToolName(
  name: string,
  grammar: ToolNameGrammar = DOTTED_TOOL_NAME_GRAMMAR
): boolean {
  return name.length > 0 && name.length <= TOOL_NAME_MAX_LENGTH && grammar.pattern.test(name);
}

/**
 * Deterministically coerce a single name into the legal grammar:
 *   - already-legal names pass through unchanged (so well-formed MCP ids like
 *     `mcp__server__tool` keep their intentional `__` separators),
 *   - disallowed characters become `_`,
 *   - runs of `_` collapse to a single `_`,
 *   - the result is capped at 64 chars,
 *   - an empty result degrades to `_` (never an empty name).
 *
 * This is a pure function of its input: the same original always yields the
 * same segment, which is what lets independent call sites agree on a mapping.
 * Collision disambiguation across different originals is layered on top by the
 * request-scoped sanitizer, not here.
 *
 * `grammar` selects the wire's character class — default (dots allowed) for
 * chat-completions, `NO_DOTS_TOOL_NAME_GRAMMAR` for the Responses wire.
 */
export function sanitizeToolNameSegment(
  name: string,
  grammar: ToolNameGrammar = DOTTED_TOOL_NAME_GRAMMAR
): string {
  if (isValidToolName(name, grammar)) return name;

  let sanitized = name.replace(grammar.illegal, '_').replace(/_{2,}/g, '_');
  if (sanitized.length === 0) sanitized = '_';
  if (sanitized.length > TOOL_NAME_MAX_LENGTH) {
    sanitized = sanitized.slice(0, TOOL_NAME_MAX_LENGTH);
  }
  return sanitized;
}

/**
 * Registration guard — throws when a tool id can't be represented on an
 * OpenAI-compatible wire. Wired into the tool-sync path so a new folder-backed
 * or programmatically-registered tool can't mint an id that would silently
 * break OpenAI/Copilot at chat time. (Names already persisted in old threads
 * are handled defensively by the wire-level sanitizer instead — this guard
 * only stops NEW bad ids.)
 */
export function assertValidToolId(id: string, context?: string): void {
  if (isValidToolName(id)) return;
  const where = context ? ` (${context})` : '';
  throw new Error(
    `Invalid tool id "${id}"${where}: tool ids must match ${TOOL_NAME_PATTERN} ` +
      `and be 1-${TOOL_NAME_MAX_LENGTH} chars (OpenAI/Copilot function-name grammar).`
  );
}
