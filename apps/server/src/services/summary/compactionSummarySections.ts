/**
 * The fallback for a fold that could not read the earlier summary. Normally the summarizer rolls the
 * earlier summary into one updated summary that replaces it (historyCompactionSummary); only when the
 * earlier summary is too big to sit beside the new span in the summary model's window are the new
 * notes appended here under a `## Fold N` heading, an earlier section never rewritten.
 *
 * The summary is injected as `messages[0]` of every later turn and a later fold cannot move it (it
 * is a single message), so it is capped: past the cap the oldest fold sections go first, whole, with
 * a one-line marker. The newest fold's notes are always kept.
 */

/** Most characters the carried compaction summary keeps. */
export const COMPACTION_SUMMARY_MAX_CHARS = 64_000;

/** Where older fold sections were dropped. */
export const COMPACTION_FOLDS_TRIMMED_MARKER = '[Earlier folds trimmed]';

const SECTION_BREAK = '\n\n';
/** A fold section starts at a `## Fold N` line at the start of the text or after a blank line. */
const SECTION_START = /(?:^|\n\n)(?=## Fold \d+\n)/;
const FOLD_NUMBER = /^## Fold (\d+)\n/;

export function appendFoldSection(prior: string | null | undefined, notes: string): string {
  let earlier = (prior ?? '').trim();
  let dropped = false;
  if (earlier.startsWith(COMPACTION_FOLDS_TRIMMED_MARKER)) {
    dropped = true;
    earlier = earlier.slice(COMPACTION_FOLDS_TRIMMED_MARKER.length).trim();
  }

  // A summary saved before fold headings existed is one unnumbered section: kept whole, and the
  // first to go.
  const sections = earlier
    .split(SECTION_START)
    .map((part) => part.trim())
    .filter(Boolean);
  const lastNumber = sections.reduce((max, section) => {
    const match = FOLD_NUMBER.exec(section);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const foldNumber = (lastNumber || sections.length) + 1;
  const added = `## Fold ${foldNumber}\n${notes.trim()}`;

  const render = (parts: string[], omitted: boolean): string =>
    [...(omitted ? [COMPACTION_FOLDS_TRIMMED_MARKER] : []), ...parts, added].join(SECTION_BREAK);

  let kept = sections;
  let text = render(kept, dropped);
  while (text.length > COMPACTION_SUMMARY_MAX_CHARS && kept.length > 0) {
    kept = kept.slice(1);
    dropped = true;
    text = render(kept, dropped);
  }
  return text;
}
