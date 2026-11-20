/**
 * Doc line links: point a chip at part of a doc instead of the whole thing.
 *
 *   doc-…#L12            one line
 *   doc-…#L12-L20        lines 12 to 20 (inclusive)
 *   doc-…#L12:5-L14:30   line 12 char 5 to line 14 char 30 (1-indexed, inclusive)
 *
 * Lines are 1-indexed over the doc's raw markdown split on `\n` — the same
 * numbering `search` content_range uses, so an agent can read a range and
 * link it with the same numbers. The fragment never changes the target node:
 * backlinks, previews and existence checks all use the bare id.
 */

export interface LineRef {
  startLine: number;
  /** Inclusive. Equals startLine for a single-line ref. */
  endLine: number;
  /** 1-indexed inclusive start column on startLine, when char-precise. */
  startChar?: number;
  /** 1-indexed inclusive end column on endLine, when char-precise. */
  endChar?: number;
}

export interface SplitLineRef {
  /** The href / id with any `#L…` fragment removed. */
  id: string;
  /** The parsed range, or null when there is no (valid) line fragment. */
  lines: LineRef | null;
}

// The canonical range is `L12-L20`, but chips label it `L12–20`, so links
// get written the way the label reads: an en or em dash (or another Unicode
// hyphen) between the ends, no second `L`, a lowercase `l`. All of them name
// the same range. The dash class reads the same in a JavaScript and a
// PostgreSQL regex.
const RANGE_DASH = '[-\\u2010-\\u2015\\u2212]';
// Those dashes percent-encoded, as markdown parsers leave them in an href.
const ENCODED_DASH = '%2[Dd]|%[Ee]2%80%9[0-5]|%[Ee]2%88%92';
const ENCODED_DASH_RE = new RegExp(ENCODED_DASH, 'g');

/** Source for the fragment, without the leading `#`. Shared by href regexes. */
export const LINE_FRAGMENT_SOURCE = `[Ll]\\d+(?::\\d+)?(?:${RANGE_DASH}[Ll]?\\d+(?::\\d+)?)?`;

/**
 * The same grammar as a PostgreSQL regex fragment (no leading `#`), for the
 * doc-link trigger functions in `packages/db/migrations/0001_init.sql`
 * (`rebuild_doc_inline_links`, `sync_doc_links`). They read links in stored
 * markdown, so a dash may still be percent-encoded. A regex cannot check the
 * range order, so a backwards range such as `L5-L3` still links the doc there.
 * The baseline must hold this exact text; `docLineRef.test.ts` checks that
 * and feeds both grammars the same fixtures.
 */
export const LINE_FRAGMENT_SQL_SOURCE = `[Ll][0-9]+(?::[0-9]+)?(?:(?:${RANGE_DASH}|${ENCODED_DASH})[Ll]?[0-9]+(?::[0-9]+)?)?`;

const FRAGMENT_RE = new RegExp(`^[Ll](\\d+)(?::(\\d+))?(?:${RANGE_DASH}[Ll]?(\\d+)(?::(\\d+))?)?$`);

/** Undo the percent-encoding of a range dash; any other escape is not a range. */
function decodeFragment(fragment: string): string | null {
  const decoded = fragment.replace(ENCODED_DASH_RE, (dash) => decodeURIComponent(dash));
  return decoded.includes('%') ? null : decoded;
}

/** Parse a fragment like `L12-L20` / `L12:5-L14:30` (no leading `#`). Also
 *  reads the hand-written forms `L12–20`, `L12-20`, `l12-l20` and a
 *  percent-encoded dash. */
export function parseLineFragment(fragment: string): LineRef | null {
  const decoded = decodeFragment(fragment.trim());
  const m = decoded === null ? null : FRAGMENT_RE.exec(decoded);
  if (!m) return null;
  const startLine = Number(m[1]);
  const startChar = m[2] != null ? Number(m[2]) : undefined;
  const endLine = m[3] != null ? Number(m[3]) : startLine;
  const endChar = m[4] != null ? Number(m[4]) : undefined;
  if (startLine < 1 || endLine < startLine) return null;
  // Char precision needs both ends; `L12:5-L14` is ambiguous, so reject it.
  if ((startChar == null) !== (endChar == null)) return null;
  if (startChar != null && (startChar < 1 || endChar! < 1)) return null;
  if (startChar != null && startLine === endLine && endChar! < startChar) return null;
  return {
    startLine,
    endLine,
    ...(startChar != null ? { startChar, endChar } : {}),
  };
}

/**
 * Split `doc-…#L12-L20` into its id and range. Any href without a valid `#L…`
 * fragment comes back unchanged with `lines: null` (so other `#` uses are kept).
 */
export function splitLineRef(href: string): SplitLineRef {
  const hash = href.indexOf('#');
  if (hash < 0) return { id: href, lines: null };
  const lines = parseLineFragment(href.slice(hash + 1));
  return lines ? { id: href.slice(0, hash), lines } : { id: href, lines: null };
}

/** `L12`, `L12-L20` or `L12:5-L14:30` (no leading `#`). */
export function formatLineFragment(lines: LineRef): string {
  if (lines.startChar != null && lines.endChar != null) {
    return `L${lines.startLine}:${lines.startChar}-L${lines.endLine}:${lines.endChar}`;
  }
  return lines.endLine === lines.startLine
    ? `L${lines.startLine}`
    : `L${lines.startLine}-L${lines.endLine}`;
}

/** `doc-…#L12-L20`. */
export function withLineRef(id: string, lines: LineRef): string {
  return `${id}#${formatLineFragment(lines)}`;
}

/** Short human label: `L12`, `L12–20`, `L12:5–14:30`. */
export function lineRefLabel(lines: LineRef): string {
  if (lines.startChar != null && lines.endChar != null) {
    return `L${lines.startLine}:${lines.startChar}–${lines.endLine}:${lines.endChar}`;
  }
  return lines.endLine === lines.startLine
    ? `L${lines.startLine}`
    : `L${lines.startLine}–${lines.endLine}`;
}

export interface LineSlice {
  /** The referenced text. */
  text: string;
  /** The range actually served, clamped to the doc's length. */
  startLine: number;
  endLine: number;
  totalLines: number;
  /** True when the requested range ran past the end of the doc. */
  clamped: boolean;
  /** True when the doc is shorter than startLine: nothing to show. */
  outOfRange: boolean;
}

/**
 * Where {@link sliceLineRef}'s text sits in `content`, as character offsets,
 * so a caller can map positions in the slice back to the whole doc. Null when
 * the doc is shorter than `startLine`.
 */
export function lineRefOffsets(
  content: string,
  lines: LineRef
): { start: number; end: number } | null {
  const all = content.split('\n');
  if (lines.startLine > all.length) return null;
  const endLine = Math.min(lines.endLine, all.length);
  const lineStart = (line: number): number => {
    let offset = 0;
    for (let i = 0; i < line - 1; i++) offset += all[i]!.length + 1;
    return offset;
  };
  const firstStart = lineStart(lines.startLine);
  const lastStart = lineStart(endLine);
  const firstLength = all[lines.startLine - 1]!.length;
  const lastLength = all[endLine - 1]!.length;
  if (lines.startChar == null || lines.endChar == null) {
    return { start: firstStart, end: lastStart + lastLength };
  }
  const end =
    lastStart + (endLine === lines.endLine ? Math.min(lines.endChar, lastLength) : lastLength);
  const start = Math.min(firstStart + lines.startChar - 1, firstStart + firstLength);
  return { start: Math.min(start, end), end };
}

/** Slice `content` to a line ref. Char positions are clamped to each line. */
export function sliceLineRef(content: string, lines: LineRef): LineSlice {
  const all = content.split('\n');
  const totalLines = all.length;
  if (lines.startLine > totalLines) {
    return {
      text: '',
      startLine: lines.startLine,
      endLine: lines.endLine,
      totalLines,
      clamped: true,
      outOfRange: true,
    };
  }
  const endLine = Math.min(lines.endLine, totalLines);
  const picked = all.slice(lines.startLine - 1, endLine);
  if (lines.startChar != null && lines.endChar != null) {
    const last = picked.length - 1;
    // Trim the end first so single-line refs measure endChar on the original line.
    if (endLine === lines.endLine) picked[last] = picked[last]!.slice(0, lines.endChar);
    picked[0] = picked[0]!.slice(lines.startChar - 1);
  }
  return {
    text: picked.join('\n'),
    startLine: lines.startLine,
    endLine,
    totalLines,
    clamped: endLine < lines.endLine,
    outOfRange: false,
  };
}
