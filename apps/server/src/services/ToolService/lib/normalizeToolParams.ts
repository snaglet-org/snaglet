/**
 * normalizeToolParams — the alias-normalization chokepoint for builtin tool input.
 *
 * `ToolExecutor.execute()` calls this once, for every builtin tool call,
 * right before invoking the handler. Each tool's `param_aliases` (declared
 * on its `definition.ts`, see `ToolDefinition.param_aliases`) says which
 * internal key the handler reads today and which agent-facing alias name(s)
 * should also populate it — most commonly the standardized `id`, sometimes
 * an older name kept for backward compatibility (e.g. `source_id`).
 *
 * This function is pure and data-driven: there is no per-tool branching here
 * or at the call site. Handler code and internal variable names are never
 * touched: if the caller already supplied the internal key directly (e.g. a
 * caller sending `doc_id`), it is left exactly as-is and always
 * wins over any alias.
 */
export function normalizeToolParams(
  input: Record<string, unknown>,
  paramAliases: Record<string, string[]> | undefined
): Record<string, unknown> {
  if (!paramAliases) return input;

  // Copy-on-write: only clone `input` if an alias actually needs to be
  // applied, so the common case (no aliasing needed) is a no-op passthrough.
  let out: Record<string, unknown> | null = null;

  for (const [internalKey, aliases] of Object.entries(paramAliases)) {
    // The handler's own key always wins — never overwrite an explicit value.
    if (input[internalKey] !== undefined) continue;

    for (const alias of aliases) {
      if (input[alias] !== undefined) {
        if (!out) out = { ...input };
        out[internalKey] = input[alias];
        break;
      }
    }
  }

  return out ?? input;
}
