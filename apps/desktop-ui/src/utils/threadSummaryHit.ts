/**
 * Rendering helpers for `thread_summary` palette-search hits. Every such row
 * has `payload.title === 'Thread summary'`, so these pull out what tells them
 * apart: a preview of the summary text, the parent thread's title, and the
 * created timestamp. Used by @-mention search, the command palette and the
 * workspace-tree search.
 */

const MAX_PREVIEW_CHARS = 140;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Collapse whitespace and clip to a single line so the preview fits on a
 * result row without wrapping. Adds an ellipsis when the text exceeds the
 * character budget.
 */
function previewSummaryText(raw: string, maxChars = MAX_PREVIEW_CHARS): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}

export interface ThreadSummaryHitDisplay {
  /** Snippet of the matched summary text, single line, ellipsized. */
  preview: string;
  /** Parent thread title to surface as the result's path/context. */
  threadTitle: string;
  /** Underlying thread id when present (for navigation / linking). */
  threadId: string | null;
  /** ISO created timestamp when present. */
  createdAt: string | null;
}

/**
 * Resolve display data for a `thread_summary` palette-search hit payload.
 * Falls back to safe defaults when fields are missing so callers can render
 * without per-field guards.
 */
export function extractThreadSummaryDisplay(
  payload: Record<string, unknown> | null | undefined
): ThreadSummaryHitDisplay {
  const safe = payload ?? {};
  const preview = isNonEmptyString(safe.summaryText)
    ? previewSummaryText(safe.summaryText)
    : 'Thread summary';
  const threadTitle = isNonEmptyString(safe.threadTitle)
    ? safe.threadTitle.trim()
    : 'Untitled thread';
  const threadId = isNonEmptyString(safe.threadId) ? safe.threadId : null;
  const createdAt = isNonEmptyString(safe.createdAt) ? safe.createdAt : null;
  return { preview, threadTitle, threadId, createdAt };
}

/** Human-readable date+time suitable for a one-line result row. */
export function formatThreadSummaryDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const day = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${day} · ${time}`;
}
