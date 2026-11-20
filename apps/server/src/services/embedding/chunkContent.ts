/**
 * chunkContent — structure-aware splitter for embedding long content.
 *
 * Strategy:
 *   1. Content that fits the budget is returned as a single chunk — the
 *      common case costs nothing.
 *   2. Otherwise the chunk COUNT is computed first (`ceil(len / budget)`)
 *      and the splitter aims for equal-size chunks. This avoids the
 *      classic greedy failure mode of N full chunks + one tiny runt whose
 *      embedding is mostly noise.
 *   3. Each cut lands on the best structural boundary near its target
 *      position, preferred in order: markdown heading > paragraph break >
 *      line break > sentence end > word boundary > hard cut.
 *   4. Each chunk's embed text is prefixed with the word-aligned tail of
 *      the previous chunk (the overlap) so meaning that straddles a cut
 *      isn't orphaned from both chunks. `start`/`end` describe the CORE
 *      span (overlap excluded) so offsets map 1:1 onto the source.
 *
 * Budgets are in characters — callers convert the model's token window
 * via the chars-per-token heuristic (see contentBudgetChars).
 */

export interface ContentChunk {
  /** Text to embed: overlap prefix (if any) + the core span. */
  text: string;
  /** 0-based position within the chunk set. */
  index: number;
  /** Char offset of the core span's start in the source content. */
  start: number;
  /** Char offset of the core span's end (exclusive) in the source content. */
  end: number;
}

export interface ChunkContentOptions {
  /** Max characters per emitted chunk text (overlap included). */
  maxChars: number;
  /**
   * Characters of trailing context carried from the previous chunk.
   * Defaults to 10% of maxChars. Always word-aligned.
   */
  overlapChars?: number;
}

/**
 * Rough chars-per-token for natural language + markdown. Real tokenizers
 * vary (3–4.5 chars/token for English); 4 with the safety margin below
 * keeps us comfortably inside the model's window without wasting half of
 * it.
 */
const CHARS_PER_TOKEN = 4;

/** Fraction of the model's context window we actually use. */
const SAFETY_MARGIN = 0.85;

/** Convert a model's max input tokens to a character budget. */
export function contentBudgetChars(maxInputTokens: number): number {
  return Math.max(200, Math.floor(maxInputTokens * CHARS_PER_TOKEN * SAFETY_MARGIN));
}

/**
 * Boundary patterns from most to least desirable. Each match's break
 * position is the end of the match (cut after separators) except headings,
 * where we cut before the heading line so the heading stays with its
 * section.
 */
const BOUNDARIES: Array<{ pattern: RegExp; breakAt: 'start' | 'end' }> = [
  { pattern: /\n#{1,6}\s/g, breakAt: 'start' },
  { pattern: /\n\s*\n/g, breakAt: 'end' },
  { pattern: /\n/g, breakAt: 'end' },
  { pattern: /[.!?]["')\]]?\s+/g, breakAt: 'end' },
  { pattern: /\s+/g, breakAt: 'end' },
];

/**
 * Find the best break position inside [windowStart, windowEnd), preferring
 * higher-priority boundaries and, within a priority level, the match
 * closest to the window's end (keeps chunks near their target size).
 * Returns -1 when no boundary exists in the window.
 */
function bestBreak(text: string, windowStart: number, windowEnd: number): number {
  if (windowEnd <= windowStart) return -1;
  const slice = text.slice(windowStart, windowEnd);
  for (const { pattern, breakAt } of BOUNDARIES) {
    pattern.lastIndex = 0;
    let best = -1;
    for (const m of slice.matchAll(pattern)) {
      const pos = breakAt === 'start' ? m.index + 1 : m.index + m[0].length;
      // `+1` on 'start': the boundary is the \n itself; break after it so
      // the heading begins the next chunk.
      if (pos > 0 && pos < slice.length && pos > best) best = pos;
    }
    if (best > 0) return windowStart + best;
  }
  return -1;
}

/** Word-aligned tail of `text`, at most `maxLen` chars. */
function wordAlignedTail(text: string, maxLen: number): string {
  if (maxLen <= 0 || !text) return '';
  if (text.length <= maxLen) return text;
  const tail = text.slice(-maxLen);
  const firstSpace = tail.search(/\s/);
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}

export function chunkContent(content: string, options: ChunkContentOptions): ContentChunk[] {
  const maxChars = Math.max(200, options.maxChars);
  if (content.length <= maxChars) {
    return [{ text: content, index: 0, start: 0, end: content.length }];
  }

  const overlap = Math.min(
    Math.max(0, options.overlapChars ?? Math.floor(maxChars * 0.1)),
    Math.floor(maxChars / 4)
  );
  // Core budget: what each chunk can hold after reserving overlap space.
  const coreBudget = maxChars - overlap;

  // Balanced sizing: pick the chunk count first, then aim each cut at an
  // equal share so the last chunk isn't a runt.
  const count = Math.ceil(content.length / coreBudget);
  const target = Math.ceil(content.length / count);

  const chunks: ContentChunk[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const remaining = content.length - cursor;
    let end: number;
    if (remaining <= coreBudget) {
      end = content.length;
    } else {
      // Look for a boundary near the balanced target: within ±25% of the
      // target size, clamped to the hard budget.
      const idealEnd = cursor + Math.min(target, coreBudget);
      const slack = Math.floor(target * 0.25);
      const windowStart = Math.max(cursor + Math.floor(target * 0.5), cursor + 1);
      const windowEnd = Math.min(idealEnd + slack, cursor + coreBudget, content.length);
      const broken = bestBreak(content, Math.min(windowStart, windowEnd - 1), windowEnd);
      end = broken > cursor ? broken : windowEnd;
    }

    const core = content.slice(cursor, end);
    const prefix =
      chunks.length > 0 ? wordAlignedTail(content.slice(0, cursor).trimEnd(), overlap) : '';
    chunks.push({
      text: prefix ? `${prefix}\n${core}` : core,
      index: chunks.length,
      start: cursor,
      end,
    });
    cursor = end;
  }

  return chunks;
}
