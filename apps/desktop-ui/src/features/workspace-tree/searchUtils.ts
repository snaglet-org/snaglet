import { paletteHitContext, type PaletteSearchHit } from '../../utils/api';
import { extractThreadSummaryDisplay } from '@desktop/utils/threadSummaryHit';

/**
 * Map a search-hit kind to the sidebar view that actually owns it. Tools
 * live in the Tools view and agents in the Agents view. Everything else
 * (tables included) lives in the library tree,
 * so we return null and let the tree reveal it in place.
 */
export function viewForHitKind(kind: string): string | null {
  switch (kind) {
    case 'tool':
      return 'tools';
    case 'agent':
      return 'agents';
    default:
      return null;
  }
}

/**
 * Resolve a human-readable label for a search hit from its payload. Kinds
 * carry different title fields (title / name / content snippet), so fall
 * back through the common ones before defaulting to 'Untitled'.
 */
export function getPaletteHitLabel(hit: PaletteSearchHit): string {
  // Thread-summary rows ship `payload.title === 'Thread summary'` so the
  // generic title lookup gives every summary the same label. Prefer the
  // actual matched summary text instead.
  if (hit.kind === 'thread_summary') {
    return extractThreadSummaryDisplay(hit.payload).preview;
  }
  const p = (hit.payload ?? {}) as Record<string, unknown>;
  const pick = (k: string): string | null =>
    typeof p[k] === 'string' && (p[k] as string).trim() ? (p[k] as string) : null;
  const raw = pick('title') ?? pick('name') ?? pick('content') ?? null;
  if (!raw) return 'Untitled';
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}\u2026` : oneLine;
}

export function getPaletteHitContext(hit: PaletteSearchHit): string | null {
  return paletteHitContext(hit);
}
