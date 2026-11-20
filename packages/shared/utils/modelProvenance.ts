/**
 * Shared helpers for summary provenance: the `model_used` stamp that
 * `SummaryService` writes on every thread-summary version as
 * `` `${providerId}/${modelId}` `` (e.g. `anthropic/claude-opus-4`).
 *
 * Shared so the two places a summary is read — the summary card in the UI and
 * the exported transcript's compaction block — render the same provenance the
 * same way. Both sides import from here rather than each splitting the string
 * themselves, because the parsing has two non-obvious cases (below) and a lone
 * `/` leaking into a human-facing surface reads as a bug.
 *
 * ## Two rules that look arbitrary and are not
 *
 * 1. **Split on the first slash only.** A model id may itself contain slashes —
 *    LM Studio ids are `publisher/model` — so `lmstudio/qwen/qwen3-4b` is
 *    provider `lmstudio` and model `qwen/qwen3-4b`. Splitting on every slash
 *    would silently truncate those model names.
 *
 * 2. **A value with no slash is kept whole, not rejected.** Rows written before
 *    provenance was provider-qualified (and any future writer that stamps a
 *    bare model id) still name a real model. Showing `qwen2.5:3b` is more
 *    honest than showing nothing, and far better than showing `/qwen2.5:3b`.
 *
 * Nothing here writes to `summaryText`: provenance is rendered from the
 * structured field at display time. Baking it into the stored prose would
 * pollute the summary's embedding and every quote exported from it.
 */

export interface ModelProvenance {
  /** Provider segment, or null when the stamp carried no provider. */
  providerId: string | null;
  /** Model segment. Never empty — a value with nothing usable parses to null. */
  modelId: string;
}

/** True when a value contains at least one character that is not a separator. */
function namesSomething(value: string): boolean {
  return /[^/\s]/.test(value);
}

/**
 * Parse a stored `model_used` stamp into its provider and model parts.
 *
 *   "anthropic/claude-opus-4"  → { providerId: 'anthropic', modelId: 'claude-opus-4' }
 *   "lmstudio/qwen/qwen3-4b"   → { providerId: 'lmstudio', modelId: 'qwen/qwen3-4b' }
 *   "qwen2.5:3b"               → { providerId: null, modelId: 'qwen2.5:3b' }
 *   null / "" / "   " / "/"    → null
 *
 * Returns null for anything with no model to name, so callers can render
 * nothing at all rather than an empty label or a bare separator.
 */
export function parseModelUsed(modelUsed: string | null | undefined): ModelProvenance | null {
  const raw = typeof modelUsed === 'string' ? modelUsed.trim() : '';
  // Separators and whitespace alone name nothing — this is the guard that stops
  // "/", " / " and "//" from ever reaching a caller as a renderable label.
  if (!namesSomething(raw)) return null;

  const separator = raw.indexOf('/');
  // No separator: the whole value is the model name (rule 2 above).
  if (separator === -1) return { providerId: null, modelId: raw };

  const providerId = raw.slice(0, separator).trim();
  // slice from the separator, not split — everything after the first `/` stays
  // together so publisher-qualified model ids survive intact (rule 1 above).
  const modelId = raw.slice(separator + 1).trim();

  // Half-empty stamps ("anthropic/", "/gpt-5") still name one real thing, so
  // show that half unqualified rather than dropping the row's provenance.
  // `raw` names something, so if the model half doesn't, the provider half does.
  if (!namesSomething(modelId)) return { providerId: null, modelId: providerId };
  if (!providerId) return { providerId: null, modelId: modelId.replace(/^\/+/, '') };

  return { providerId, modelId };
}

/**
 * The display string for a `model_used` stamp, or null when there is nothing
 * to show. Callers render nothing on null — never a placeholder, never a bare
 * separator.
 *
 *   "anthropic/claude-opus-4"  → "anthropic/claude-opus-4"
 *   "  openai / gpt-5  "       → "openai/gpt-5"
 *   "qwen2.5:3b"               → "qwen2.5:3b"
 *   null                       → null
 */
export function formatModelUsed(modelUsed: string | null | undefined): string | null {
  const parsed = parseModelUsed(modelUsed);
  if (!parsed) return null;
  return parsed.providerId ? `${parsed.providerId}/${parsed.modelId}` : parsed.modelId;
}
