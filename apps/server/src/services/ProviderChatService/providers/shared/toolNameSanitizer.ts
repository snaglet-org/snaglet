/**
 * Request-scoped, collision-aware, round-trippable tool-name sanitizer for the
 * OpenAI-compatible chat-completions wire.
 *
 * A single instance is built per request and used at both wire sites so the
 * round-trip stays correlated:
 *
 *   Outbound: advertised `tools[].function.name` and every historical
 *   `tool_use.name` in the replayed message array are passed through
 *   `sanitize()`. Illegal characters (e.g. the `→` in a poisoned
 *   `action→<id>`, or a `:` in an MCP tool name) become legal, so OpenAI /
 *   Copilot don't reject the request with a 400.
 *
 *   Inbound: the model echoes back the sanitized name it was shown.
 *   `resolve()` maps it back to the original tool id so downstream dispatch
 *   (which keys off the real id) and persistence keep working unchanged.
 *
 * Because `sanitizeToolNameSegment` is a pure function, two different originals
 * can collapse to the same segment. When that happens `sanitize()` appends a
 * deterministic `_2`, `_3`, … suffix so distinct tools never share a wire name
 * (and the reverse map stays unambiguous). Seed the canonical tool ids first
 * (see the chat-completions builder) so live tools win the un-suffixed name and
 * only stale historical names take a suffix.
 */

import {
  sanitizeToolNameSegment,
  TOOL_NAME_MAX_LENGTH,
  DOTTED_TOOL_NAME_GRAMMAR,
  type ToolNameGrammar,
} from '@server/services/ToolService/lib/toolName';

export interface ToolNameSanitizer {
  /** Original tool id/name → a legal, request-unique wire name (memoized). */
  sanitize(original: string): string;
  /** Wire name echoed by the model → the original tool id (identity if unknown). */
  resolve(sanitized: string): string;
}

/**
 * `grammar` selects the wire's function-name character class. The default
 * (dots allowed) is the OpenAI chat-completions wire; the Responses wire
 * (codex + copilot/responses) passes `NO_DOTS_TOOL_NAME_GRAMMAR` because that
 * surface 400s on a dotted name.
 */
export function createToolNameSanitizer(
  grammar: ToolNameGrammar = DOTTED_TOOL_NAME_GRAMMAR
): ToolNameSanitizer {
  const forward = new Map<string, string>(); // original -> wire name
  const reverse = new Map<string, string>(); // wire name -> original

  function sanitize(original: string): string {
    const cached = forward.get(original);
    if (cached !== undefined) return cached;

    const base = sanitizeToolNameSegment(original, grammar);
    let candidate = base;
    // Only DIFFERENT originals collide (same original was returned above).
    for (let n = 2; reverse.has(candidate); n += 1) {
      const suffix = `_${n}`;
      candidate = base.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length) + suffix;
    }

    forward.set(original, candidate);
    reverse.set(candidate, original);
    return candidate;
  }

  function resolve(sanitized: string): string {
    return reverse.get(sanitized) ?? sanitized;
  }

  return { sanitize, resolve };
}
