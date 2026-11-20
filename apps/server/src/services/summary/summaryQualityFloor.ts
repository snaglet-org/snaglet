/**
 * summaryQualityFloor — the summary output contract. Small local models can and
 * do produce garbage: refusals ("I cannot summarize…"), preamble-only
 * output, replies cut mid-sentence by a token limit, or wild over-length
 * parroting. A summary that fails this floor is DISCARDED (the caller
 * retries once with a simplified prompt, then skips visibly) — a bad
 * summary silently corrupts compaction memory, which is worse than none.
 *
 * Plain text in, plain text out: no JSON is ever demanded of the model.
 */

export interface QualityFloorOptions {
  /** Below this the "summary" is presumed garbage/preamble. */
  minChars?: number;
  /** Above this the model is parroting rather than summarizing. */
  maxChars?: number;
  /**
   * The provider reported the output stopped at the token cap
   * (`max_tokens` / `length` / `incomplete`). Always fatal, whatever the text
   * looks like. Undefined when the provider gave no stop reason (local
   * runtimes) — the text-shape checks below then stand alone.
   */
  providerTruncated?: boolean;
  /**
   * The output is structured notes (labeled sections, lists of paths and
   * values), not prose: its last line is often a path or a number, so a
   * missing terminal punctuation mark is not read as a cut. The provider stop
   * reason and the fence / backtick / dangling-marker checks still apply.
   */
  structured?: boolean;
}

export type QualityFloorVerdict = { ok: true; text: string } | { ok: false; problem: string };

const DEFAULT_MIN_CHARS = 30;
const DEFAULT_MAX_CHARS = 8_000;

/**
 * Refusal / meta-response openers. Checked against the start of the reply
 * (models put refusals first) — a summary legitimately CONTAINING these
 * words later is fine.
 */
const REFUSAL_PATTERN =
  /^(i\s+can\s*(not|'?t)|i\s+cannot|i'?m\s+(unable|sorry|afraid)|i\s+am\s+(unable|sorry|afraid)|sorry[,.]|unfortunately[,.]|as\s+an\s+ai|i\s+do\s+not\s+have|i\s+don'?t\s+have|there\s+is\s+no\s+conversation)/i;

/**
 * A reply that ends mid-word/mid-clause was almost certainly cut by a token
 * limit. Terminal punctuation, closing brackets/quotes, or a markdown
 * structure terminator all count as a clean ending.
 */
const CLEAN_ENDING_PATTERN = /[.!?…)\]"'`*_~’”]\s*$/;

/**
 * A markdown marker left dangling at the very end (`` ` ``, `*`, `_`, `~`
 * preceded by whitespace or start of text) is an OPENED span that never got
 * its content — a cut, even though the character itself is in
 * CLEAN_ENDING_PATTERN. `foo_` / `**bold**` (no whitespace before) stay clean.
 */
const DANGLING_MARKER_PATTERN = /(^|\s)[`*_~]+\s*$/;

/**
 * Text-shape truncation check that works with no provider stop signal.
 * Returns a problem string, or null when the ending looks complete.
 */
function detectTruncatedEnding(
  text: string,
  options: { structured?: boolean } = {}
): string | null {
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) return 'truncated inside a fenced code block';
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  const tickCount = (withoutFences.match(/`/g) ?? []).length;
  if (tickCount % 2 === 1) return 'truncated inside an inline code span (unbalanced backticks)';
  if (DANGLING_MARKER_PATTERN.test(text)) return 'truncated after a dangling markdown marker';
  if (!options.structured && !CLEAN_ENDING_PATTERN.test(text)) {
    return 'truncated mid-sentence (no terminal punctuation)';
  }
  return null;
}

/** Strip a leading "Summary:" style label the model may add. */
function stripLabel(text: string): string {
  return text.replace(/^\s*(summary|thread summary|updated summary)\s*[:\-–—]\s*/i, '');
}

export function applySummaryQualityFloor(
  raw: string,
  options: QualityFloorOptions = {}
): QualityFloorVerdict {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const text = stripLabel(raw.trim()).trim();

  if (text.length === 0) return { ok: false, problem: 'empty output' };
  if (text.length < minChars) {
    return { ok: false, problem: `too short (${text.length} chars < ${minChars})` };
  }
  if (REFUSAL_PATTERN.test(text)) {
    return { ok: false, problem: 'refusal/meta response instead of a summary' };
  }
  if (text.length > maxChars) {
    return { ok: false, problem: `too long (${text.length} chars > ${maxChars})` };
  }
  if (options.providerTruncated) {
    return { ok: false, problem: 'truncated at the output token cap (provider stop reason)' };
  }
  const endingProblem = detectTruncatedEnding(text, { structured: options.structured });
  if (endingProblem) return { ok: false, problem: endingProblem };
  return { ok: true, text };
}
