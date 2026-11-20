/**
 * contentRange — bounded, authoritative line reads for the `search` tool.
 *
 * `search({ id, content_range })` is the "I already know which node, now show me
 * exactly these lines" path. It is deliberately part of the ONE search contract
 * rather than a separate outline/read pair: discovery (`query`), resolution
 * (`id`/`ids`), and bounded reading (`content_range`) are the same conversation.
 *
 * This module owns the pure, DB-free half of that feature: parsing/validating
 * the caller's range, slicing text into it, and the budgets that stop a ranged
 * read from turning into a token explosion. The authoritative per-kind fetch
 * lives in `rangedRead.ts`.
 *
 * Line model: 1-indexed, inclusive, split on '\n' only. A CRLF file's lines
 * keep their trailing '\r', so `slice(...).join('\n')` reproduces the source
 * bytes exactly; this is what makes "raw Markdown, chips and transclusions byte-exact"
 * true for docs and what matches `file_read`'s existing semantics.
 */

import { isRecord } from '@snaglet/shared/utils';
import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';

/** Kinds that can serve a `content_range` read in v1. */
export const RANGED_CONTENT_KINDS = ['doc', 'message', 'memory', 'file'] as const;
export type RangedContentKind = (typeof RANGED_CONTENT_KINDS)[number];

export function isRangedContentKind(kind: string): kind is RangedContentKind {
  return (RANGED_CONTENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Max span (`end_line - start_line + 1`) a single ranged read may request.
 * Exceeding it is a VALIDATION ERROR, not a silent clamp: an agent that asked
 * for 5,000 lines and silently got 500 would reason about the other 4,500 as if
 * it had seen them. Telling it to narrow is the whole point of a bounded read.
 */
export const MAX_RANGE_LINES = 500;

/** Per-item byte ceiling. Whole lines are dropped from the tail first; a single
 *  over-budget line is cut at a UTF-8 character boundary (never mid-codepoint). */
export const MAX_RANGED_ITEM_BYTES = 24_000;

/**
 * Max results a `query` + `content_range` call may range over. Ranged reads
 * multiply: `limit` results x `MAX_RANGE_LINES` lines is how a search turns into
 * a context flood. A higher `limit` with `content_range` is rejected rather than
 * silently trimmed (see `validateRangedQueryLimit`).
 */
export const MAX_RANGED_RESULTS = 5;

/** Whole-response ceiling across every ranged item in one call. Items past the
 *  budget are listed by id and explicitly marked omitted — never dropped silently. */
export const MAX_RANGED_RESPONSE_BYTES = 60_000;

/** Largest on-disk file a ranged read will pull into memory to slice. */
export const MAX_RANGED_FILE_BYTES = 2 * 1024 * 1024;

/** A validated, caller-requested range. Always 1-indexed and inclusive. */
export interface ContentRangeRequest {
  startLine: number;
  endLine: number;
}

/**
 * Bounds of the content ACTUALLY returned.
 *
 * `startLine`/`endLine` are the resolved (post-clamp) inclusive bounds, not the
 * requested ones — a request past EOF resolves to `0`/`0` with empty content
 * rather than pretending line 900 exists. `truncated` is true whenever the
 * returned text is anything less than the item's full content, for any reason
 * (range narrower than the content, EOF clamp, or byte budget).
 */
interface ResolvedContentRange {
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface RangedContent {
  content: string;
  range: ResolvedContentRange;
}

export type ContentRangeParse =
  | { ok: true; range: ContentRangeRequest | null }
  | { ok: false; error: string };

/**
 * Parse `input.content_range`. Absent/null yields `{ ok: true, range: null }` so
 * callers can treat "no range requested" and "range requested" through one shape.
 */
export function parseContentRange(input: unknown): ContentRangeParse {
  if (input == null) return { ok: true, range: null };
  if (!isRecord(input)) {
    return {
      ok: false,
      error: 'content_range must be an object: { start_line: <integer>, end_line: <integer> }.',
    };
  }
  const rawStart = input.start_line;
  const rawEnd = input.end_line;
  if (rawStart == null || rawEnd == null) {
    return {
      ok: false,
      error: 'content_range requires both start_line and end_line (1-indexed, inclusive).',
    };
  }
  if (
    typeof rawStart !== 'number' ||
    typeof rawEnd !== 'number' ||
    !Number.isInteger(rawStart) ||
    !Number.isInteger(rawEnd)
  ) {
    return { ok: false, error: 'content_range.start_line and end_line must be integers.' };
  }
  if (rawStart < 1 || rawEnd < 1) {
    return {
      ok: false,
      error: 'content_range.start_line and end_line are 1-indexed and must be >= 1.',
    };
  }
  if (rawStart > rawEnd) {
    return {
      ok: false,
      error: `content_range.start_line (${rawStart}) must be <= end_line (${rawEnd}).`,
    };
  }
  const span = rawEnd - rawStart + 1;
  if (span > MAX_RANGE_LINES) {
    return {
      ok: false,
      error:
        `content_range spans ${span} lines; the maximum is ${MAX_RANGE_LINES}. ` +
        'Request a narrower window and page through it.',
    };
  }
  return { ok: true, range: { startLine: rawStart, endLine: rawEnd } };
}

/**
 * Guard the multiplying case: a `query` + `content_range` call ranges over up to
 * `limit` results at once. Rejects rather than silently trimming, so the caller
 * knows exactly how many items its range will be applied to.
 */
export function validateRangedQueryLimit(limit: number): string | null {
  if (limit <= MAX_RANGED_RESULTS) return null;
  return (
    `content_range with a query applies to at most ${MAX_RANGED_RESULTS} results, but limit is ${limit}. ` +
    `Lower limit to ${MAX_RANGED_RESULTS} or less, or fetch an exact id with content_range instead.`
  );
}

/** Line count under the split-on-'\n' model. Empty content has zero lines. */
export function countLines(content: string): number {
  if (content === '') return 0;
  let count = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes, walking back off any
 * continuation byte so a multi-byte character is never split into a
 * replacement char.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

export interface SliceOptions {
  /** Per-item byte ceiling. Defaults to MAX_RANGED_ITEM_BYTES. */
  maxBytes?: number;
}

/**
 * Slice `content` to the requested 1-indexed inclusive line range.
 *
 * EOF behavior — clamp, and report the resolved bounds:
 *   - `end_line` past the last line clamps down to it.
 *   - `start_line` past the last line returns EMPTY content with
 *     `startLine: 0, endLine: 0` (rather than silently sliding the window down
 *     onto lines the caller did not ask for).
 *   - Empty content is zero lines: `0/0 of 0`, `truncated: false` — nothing was
 *     withheld, there is simply nothing there.
 */
export function sliceContentRange(
  content: string,
  request: ContentRangeRequest,
  options: SliceOptions = {}
): RangedContent {
  const maxBytes = options.maxBytes ?? MAX_RANGED_ITEM_BYTES;
  const totalLines = countLines(content);
  if (totalLines === 0) {
    return { content: '', range: { startLine: 0, endLine: 0, totalLines: 0, truncated: false } };
  }
  if (request.startLine > totalLines) {
    return { content: '', range: { startLine: 0, endLine: 0, totalLines, truncated: true } };
  }

  const clampedEnd = Math.min(request.endLine, totalLines);
  const window = content.split('\n').slice(request.startLine - 1, clampedEnd);

  // Fill forward under the byte budget so the accounting stays O(n): dropping
  // whole lines off the tail keeps every returned line complete, and only a
  // single first line that is itself over budget is cut mid-line.
  const selected: string[] = [];
  let bytes = 0;
  let endLine = request.startLine - 1;
  let byteTruncated = false;
  for (const line of window) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const cost = (selected.length > 0 ? 1 : 0) + lineBytes;
    if (selected.length === 0 && cost > maxBytes) {
      // Neutralize before cutting: a forged `<system-reminder` tag padded to
      // straddle the cut would otherwise lose its closing `>` and slip past
      // the later neutralization (see untrustedContent.ts).
      selected.push(truncateToBytes(neutralizeSystemFraming(line), maxBytes));
      endLine += 1;
      byteTruncated = true;
      break;
    }
    if (bytes + cost > maxBytes) {
      byteTruncated = true;
      break;
    }
    selected.push(line);
    bytes += cost;
    endLine += 1;
  }

  return {
    content: selected.join('\n'),
    range: {
      startLine: request.startLine,
      endLine,
      totalLines,
      truncated: request.startLine > 1 || endLine < totalLines || byteTruncated,
    },
  };
}

/**
 * Whole-response byte budget shared by every ranged item in one call. Callers
 * `charge()` each rendered block; once the budget is gone, remaining items are
 * reported as omitted instead of being quietly dropped.
 */
export class RangedResponseBudget {
  private remaining: number;
  private exhausted = false;

  constructor(total: number = MAX_RANGED_RESPONSE_BYTES) {
    this.remaining = total;
  }

  /** Bytes still available for the next item's content. */
  available(): number {
    return Math.max(0, this.remaining);
  }

  /** True once any item was truncated or omitted because the budget ran out. */
  wasExhausted(): boolean {
    return this.exhausted;
  }

  /** Reserve `bytes`; returns false when the budget cannot fund another item. */
  charge(bytes: number): boolean {
    if (bytes > this.remaining) {
      this.exhausted = true;
      return false;
    }
    this.remaining -= bytes;
    return true;
  }

  /** Mark the budget spent (used when an item is omitted outright). */
  markExhausted(): void {
    this.exhausted = true;
  }
}
