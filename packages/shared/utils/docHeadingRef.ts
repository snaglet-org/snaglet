/**
 * Doc heading links: point a chip at a whole section of a doc by its heading.
 *
 *   doc-…#h=rate-limits     the heading whose slug is `rate-limits`, any level
 *   doc-…#h3=rate-limits    only a level-3 heading with that slug
 *
 * A section runs from its heading down to (not including) the next heading of
 * the same or a higher level, so smaller sub-headings stay inside it.
 *
 * Slugs follow GitHub: lowercase, punctuation dropped, spaces become `-`.
 * Repeats get `-1`, `-2`, … in document order. For `#h=` the count runs over
 * every heading; for `#hN=` it runs over level-N headings only.
 *
 * Ranges: `#h=part-1..h=part-3` runs from the start of the first section to
 * the end of the last one (everything between included). Either end may pin
 * its level. Slugs never contain `.`, so `..` is unambiguous.
 *
 * Unlike line links, heading links don't drift when lines are added above:
 * the section is found by name. If a `#hN=` heading changed level, the link
 * still resolves and says so.
 *
 * Inside a doc, a link to one of its own headings needs no id: `#h=…` (any
 * form above) or GitHub's `#slug`, which names the same heading as `#h=slug`.
 * See parseInDocHeadingHref.
 */

import { sliceLineRef, splitLineRef, type LineRef } from './docLineRef';

export interface HeadingEnd {
  slug: string;
  /** 1–6 when the link pins the level (`#h3=`), else undefined. */
  level?: number;
}

export interface HeadingRef extends HeadingEnd {
  /** Range end (`#h=a..h=b`): the link runs through this heading's section. */
  to?: HeadingEnd;
}

export interface DocHeading {
  level: number;
  /** Heading text with inline markdown stripped. */
  text: string;
  /** 1-indexed source line of the heading. */
  line: number;
  /** GitHub-style slug, numbered over all headings (`#h=`). */
  slug: string;
  /** Slug numbered over same-level headings only (`#hN=`). */
  levelSlug: string;
}

/** Fragment source for href regexes, without the leading `#`. */
export const HEADING_FRAGMENT_SOURCE = 'h[1-6]?=[^)\\s#.]+(?:\\.\\.h[1-6]?=[^)\\s#.]+)?';

const END_RE = /^h([1-6])?=([^)\s#.]+)$/;

function parseEnd(part: string): HeadingEnd | null {
  const m = END_RE.exec(part);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[2]!);
  } catch {
    slug = m[2]!;
  }
  return m[1] ? { slug, level: Number(m[1]) } : { slug };
}

export function parseHeadingFragment(fragment: string): HeadingRef | null {
  const parts = fragment.trim().split('..');
  if (parts.length > 2) return null;
  const from = parseEnd(parts[0]!);
  if (!from) return null;
  if (parts.length === 1) return from;
  const to = parseEnd(parts[1]!);
  if (!to) return null;
  // `h=a..h=a` is just `h=a`.
  if (to.slug === from.slug && to.level === from.level) return from;
  return { ...from, to };
}

/** A GitHub heading anchor: letters, digits, `_` and `-` only. */
const GITHUB_SLUG_RE = /^[\p{L}\p{N}_-]+$/u;

/**
 * A link to a heading of the doc it is written in, with no doc id: `#h=…`
 * (`#h3=…`, a range) or GitHub's `#slug`. Both number repeats over every
 * heading, so `#rate-limits-1` and `#h=rate-limits-1` name the same one.
 * Null for any other href, a doc id with a fragment included.
 */
export function parseInDocHeadingHref(href: string): HeadingRef | null {
  if (!href.startsWith('#')) return null;
  const fragment = href.slice(1);
  const heading = parseHeadingFragment(fragment);
  if (heading) return heading;
  let slug: string;
  try {
    slug = decodeURIComponent(fragment);
  } catch {
    // A broken escape is not a slug.
    return null;
  }
  // Slugs are lowercase; GitHub matches `#Next-Steps` too.
  return GITHUB_SLUG_RE.test(slug) ? { slug: slug.toLowerCase() } : null;
}

const formatEnd = (end: HeadingEnd) => `h${end.level ?? ''}=${end.slug}`;

export function formatHeadingFragment(ref: HeadingRef): string {
  return ref.to ? `${formatEnd(ref)}..${formatEnd(ref.to)}` : formatEnd(ref);
}

const labelEnd = (end: HeadingEnd) => (end.level ? `h${end.level} ${end.slug}` : end.slug);

/** Short human label: `§ rate-limits`, `§ h3 rate-limits`, `§ part-1 … part-3`. */
export function headingRefLabel(ref: HeadingRef): string {
  return ref.to ? `§ ${labelEnd(ref)} … ${labelEnd(ref.to)}` : `§ ${labelEnd(ref)}`;
}

/** Strip inline markdown so the slug comes from what the reader sees. */
function plainHeadingText(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links, chips, images
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** GitHub's heading slug, before repeat numbering. */
export function headingSlug(text: string): string {
  return plainHeadingText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** A closing fence: the run alone on its line (an info string means it opens one). */
const CLOSING_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Every ATX heading in a doc's markdown, skipping fenced code. */
export function docHeadings(content: string): DocHeading[] {
  const out: DocHeading[] = [];
  const seen = new Map<string, number>();
  const seenAtLevel = new Map<string, number>();
  const number = (map: Map<string, number>, key: string, base: string) => {
    const n = map.get(key) ?? 0;
    map.set(key, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  let fence: string | null = null;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // A CRLF doc keeps its `\r` on every line split on `\n`.
    const line = (lines[i] ?? '').replace(/\r$/, '');
    if (fence === null) {
      const open = FENCE_RE.exec(line);
      if (open) {
        fence = open[1] ?? '';
        continue;
      }
    } else {
      // Only a bare run of the same character, at least as long, closes it.
      const close = CLOSING_FENCE_RE.exec(line)?.[1] ?? '';
      if (close.charAt(0) === fence.charAt(0) && close.length >= fence.length) fence = null;
      continue;
    }
    const m = ATX_RE.exec(line);
    if (!m) continue;
    const level = (m[1] ?? '').length;
    const text = plainHeadingText(m[2] ?? '');
    const base = headingSlug(m[2] ?? '');
    out.push({
      level,
      text,
      line: i + 1,
      slug: number(seen, base, base),
      levelSlug: number(seenAtLevel, `${level}:${base}`, base),
    });
  }
  return out;
}

export interface HeadingSection {
  heading: DocHeading;
  /** The section's lines (heading line through the last line before the next
   *  same-or-higher heading, trailing blank lines dropped). */
  lines: LineRef;
  /** Set when a `#hN=` link matched a heading at a different level. */
  note?: string;
}

/** Find the section a heading link points at, or null when it's gone. */
export function findHeadingSection(content: string, ref: HeadingEnd): HeadingSection | null {
  const headings = docHeadings(content);
  let index = -1;
  let note: string | undefined;
  if (ref.level) {
    index = headings.findIndex((h) => h.level === ref.level && h.levelSlug === ref.slug);
    if (index < 0) {
      // The heading may have changed level: same name anywhere else.
      index = headings.findIndex((h) => h.slug === ref.slug);
      if (index < 0) index = headings.findIndex((h) => h.levelSlug === ref.slug);
      const moved = headings[index];
      if (moved) {
        note = `This heading is now level ${moved.level} (the link says level ${ref.level}).`;
      }
    }
  } else {
    index = headings.findIndex((h) => h.slug === ref.slug);
  }
  const heading = headings[index];
  if (!heading) return null;
  const next = headings.slice(index + 1).find((h) => h.level <= heading.level);
  const all = content.split('\n');
  let end = next ? next.line - 1 : all.length;
  while (end > heading.line && all[end - 1]?.trim() === '') end--;
  return { heading, lines: { startLine: heading.line, endLine: end }, ...(note ? { note } : {}) };
}

/**
 * Every heading with the link to copy for it: `#h=slug` normally; `#hN=slug`
 * when the same name is also used at another level, so the link reads clearly.
 */
export function docOutline(content: string): Array<DocHeading & { ref: HeadingRef }> {
  const headings = docHeadings(content);
  const bases = headings.map((h) => headingSlug(h.text));
  // Levels each name is used at: one pass, so a long doc stays linear.
  const levels = new Map<string, Set<number>>();
  headings.forEach((h, i) => {
    const seen = levels.get(bases[i]!) ?? new Set<number>();
    seen.add(h.level);
    levels.set(bases[i]!, seen);
  });
  return headings.map((h, i) => {
    const otherLevel = (levels.get(bases[i]!)?.size ?? 0) > 1;
    return { ...h, ref: otherLevel ? { slug: h.levelSlug, level: h.level } : { slug: h.slug } };
  });
}

/** The heading link to copy for the heading on `headingLine` (see docOutline). */
export function headingRefFor(content: string, headingLine: number): HeadingRef | null {
  return docOutline(content).find((h) => h.line === headingLine)?.ref ?? null;
}

// Doc anchors: either kind of partial-doc link

/** Where a partial-doc link points: lines, or a heading's section. */
export type DocAnchor = { lines: LineRef } | { heading: HeadingRef };

export interface SplitDocRef {
  /** The href / id with any recognized `#…` fragment removed. */
  id: string;
  anchor: DocAnchor | null;
}

/** Split `doc-…#L12-L20` or `doc-…#h=rate-limits` into id + anchor. */
export function splitDocRef(href: string): SplitDocRef {
  const lineSplit = splitLineRef(href);
  if (lineSplit.lines) return { id: lineSplit.id, anchor: { lines: lineSplit.lines } };
  const hash = href.indexOf('#');
  if (hash < 0) return { id: href, anchor: null };
  const heading = parseHeadingFragment(href.slice(hash + 1));
  return heading ? { id: href.slice(0, hash), anchor: { heading } } : { id: href, anchor: null };
}

export function docAnchorLabel(anchor: DocAnchor, labelLines: (l: LineRef) => string): string {
  return 'lines' in anchor ? labelLines(anchor.lines) : headingRefLabel(anchor.heading);
}

export interface ResolvedAnchor {
  /** Lines the anchor covers now, or null when it can't be found. */
  lines: LineRef | null;
  /** Something the reader should know (level changed, heading missing). */
  note?: string;
}

const missing = (end: HeadingEnd) =>
  `No heading "${formatEnd(end)}" in this doc; it may have been renamed or removed.`;

/** Turn an anchor into the lines it covers in `content` today. */
export function resolveDocAnchor(content: string, anchor: DocAnchor): ResolvedAnchor {
  if ('lines' in anchor) return { lines: anchor.lines };
  const ref = anchor.heading;
  const first = findHeadingSection(content, ref);
  if (!first) return { lines: null, note: missing(ref) };
  if (!ref.to) return { lines: first.lines, ...(first.note ? { note: first.note } : {}) };

  const last = findHeadingSection(content, ref.to);
  if (!last) return { lines: null, note: missing(ref.to) };
  if (last.heading.line < first.heading.line) {
    return {
      lines: null,
      note: `"${formatEnd(ref.to)}" now comes before "${formatEnd(ref)}" in this doc; the range is out of order.`,
    };
  }
  const notes = [first.note, last.note].filter(Boolean).join(' ');
  return {
    lines: {
      startLine: first.lines.startLine,
      endLine: Math.max(first.lines.endLine, last.lines.endLine),
    },
    ...(notes ? { note: notes } : {}),
  };
}

/** Heading range to copy for a span of heading lines (one heading → plain). */
export function headingRangeFor(
  content: string,
  firstHeadingLine: number,
  lastHeadingLine: number
): HeadingRef | null {
  const from = headingRefFor(content, firstHeadingLine);
  if (!from) return null;
  if (lastHeadingLine === firstHeadingLine) return from;
  const to = headingRefFor(content, lastHeadingLine);
  return to ? { ...from, to: { slug: to.slug, ...(to.level ? { level: to.level } : {}) } } : from;
}

/** The anchored text of a doc, or null with a note. */
export function sliceDocAnchor(
  content: string,
  anchor: DocAnchor
): { text: string | null; lines: LineRef | null; note?: string } {
  const r = resolveDocAnchor(content, anchor);
  if (!r.lines) return { text: null, lines: null, note: r.note };
  return { text: sliceLineRef(content, r.lines).text, lines: r.lines, note: r.note };
}

/**
 * What a selection over `lines` should copy as a heading link, or null to
 * keep a line link. A selection that starts on a heading and covers 2+
 * headings becomes a heading range (first → last heading it covers), which
 * survives edits; anything else stays exact lines.
 */
export function headingRangeForLines(
  content: string,
  lines: LineRef
): { ref: HeadingRef; text: string } | null {
  const inside = docHeadings(content).filter(
    (h) => h.line >= lines.startLine && h.line <= lines.endLine
  );
  if (inside.length < 2 || inside[0]!.line !== lines.startLine) return null;
  const first = inside[0]!;
  const last = inside[inside.length - 1]!;
  const ref = headingRangeFor(content, first.line, last.line);
  return ref ? { ref, text: `${first.text} … ${last.text}` } : null;
}
