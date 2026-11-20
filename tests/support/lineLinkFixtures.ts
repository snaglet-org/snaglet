/**
 * Doc line-link fragments (no leading `#`) and the range each names, or null
 * when it is not a line range. One list feeds both grammars that read them:
 * `parseLineFragment` (packages/shared/utils/docLineRef.ts) and the doc-link
 * trigger regex in packages/db/migrations/0001_init.sql, so the two cannot
 * drift apart.
 */
import type { LineRef } from '@snaglet/shared/utils/docLineRef';

export const LINE_FRAGMENT_FIXTURES: ReadonlyArray<{ fragment: string; lines: LineRef | null }> = [
  // Canonical.
  { fragment: 'L3-L5', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'L7', lines: { startLine: 7, endLine: 7 } },
  { fragment: 'L3:2-L5:4', lines: { startLine: 3, endLine: 5, startChar: 2, endChar: 4 } },
  // Written the way the chip label reads, or by hand.
  { fragment: 'L3-5', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'L3–5', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'L3–L5', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'L3—L5', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'L3‐5', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'L3−5', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'l3-l5', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'l7', lines: { startLine: 7, endLine: 7 } },
  { fragment: 'L3:2–5:4', lines: { startLine: 3, endLine: 5, startChar: 2, endChar: 4 } },
  // A dash a markdown parser percent-encoded.
  { fragment: 'L3%E2%80%935', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'L3%e2%80%93L5', lines: { startLine: 3, endLine: 5 } },
  { fragment: 'L3%2D5', lines: { startLine: 3, endLine: 5 } },
  // Not line ranges.
  { fragment: 'L3–', lines: null },
  { fragment: 'L3–x', lines: null },
  { fragment: 'L', lines: null },
  { fragment: 'L1-', lines: null },
  { fragment: 'intro', lines: null },
  { fragment: 'L3%E2%80', lines: null },
  { fragment: 'L3%ZZ5', lines: null },
  { fragment: 'L3%4C5', lines: null },
];

/** Well-formed but backwards or empty: the parser rejects the range, while a
 *  regex (the trigger's) cannot check order and still links the doc. */
export const OUT_OF_ORDER_FRAGMENTS: readonly string[] = ['L5-L3', 'L0', 'L5–3'];
