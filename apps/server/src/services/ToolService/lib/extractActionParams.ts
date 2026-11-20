import { isRecord, safeJsonParse } from '@snaglet/shared/utils';

/**
 * Extract the params destined for the sub-tool from an `action` proxy call.
 *
 * The model emits `action` calls in two shapes, and the proxy must tolerate
 * both:
 *   1. Nested:    { tool: "file_read", params: { path: "/x" } }
 *   2. Flattened: { tool: "file_read", path: "/x" }
 *
 * The original implementation read only `input.params`. In the flattened
 * case `input.params` is `undefined`, so the args were silently dropped and
 * the sub-tool threw bogus "path is required" / "command is required" errors
 * even though the agent clearly passed them. This helper handles both shapes:
 *   - prefer a usable nested `params` object (or JSON string),
 *   - otherwise fall back to the remaining top-level keys, excluding the
 *     proxy's own control fields (`tool`, `tool_name`, `params`).
 */
export function extractActionParams(input: Record<string, unknown>): Record<string, unknown> {
  let nested: Record<string, unknown> = {};

  if (isRecord(input.params)) {
    nested = input.params;
  } else if (typeof input.params === 'string') {
    const parsed = safeJsonParse<unknown>(input.params);
    nested = isRecord(parsed) ? parsed : {};
  }

  // Flattened top-level keys (excluding the proxy's own control fields) are
  // always treated as sub-tool arguments, not just when `params` is empty.
  // The model frequently emits a mixed shape, e.g. a nested
  // `{ params: { path } }` alongside a large arg flattened to the top level
  // (`content`, `command`, ...). Merge both layers, with the explicit nested
  // `params` taking precedence on key collisions.
  const { tool: _tool, tool_name: _toolName, params: _params, ...flattened } = input;

  return { ...flattened, ...nested };
}
