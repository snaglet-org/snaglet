/**
 * Markdown node references in workspace docs.
 *
 * A doc points at other nodes with markdown syntax whose URL position holds a
 * node id (not a real URL):
 *   ![Display Label](doc-xxxx)   transclusion: the doc's content shown in place
 *   [Display Label](doc-xxxx)    plain link (a chip)
 *   ![](doc-xxxx) / [](doc-xxxx) empty-label variants
 *
 * These helpers find those references with their positions in the text, for
 * content-level work: rename rewrites, clone remaps, reply linting. The
 * `links` table is the authoritative graph (maintained by a DB trigger).
 */

import {
  escapeRegex,
  LINK_LABEL_SOURCE,
  maskCodeRegions,
  splitDocRef,
  type HeadingRef,
  type LineRef,
} from '@snaglet/shared/utils';

/**
 * Matches both transclusion (`!`) and plain-link forms.
 * Capture groups:
 *   1: leading `!` for a transclusion, else empty string
 *   2: label between `[` and `]` (may be empty)
 *   3: target id between `(` and `)`
 *
 * Note the `g` flag: callers must reset `lastIndex` to 0 before reusing
 * (the helpers below construct a fresh RegExp each call so they're safe).
 */
export const MARKDOWN_REF_REGEX = new RegExp(
  String.raw`(!?)\[(${LINK_LABEL_SOURCE})\]\(([^)]+)\)`,
  'g'
);

/** Match the shape of a node id like `doc-abcdef`. Tolerates any suffix chars. */
const NODE_ID_PREFIX = /^(doc|container|page|block|thread|message|agent|memory|task|post)-/;

type MarkdownRefKind = 'transclusion' | 'link';

export interface MarkdownRefHit {
  /** The captured target id (e.g. `doc-abc123`), with any `#L…` / `#h=…`
   *  fragment removed so callers always see the bare node id. */
  targetId: string;
  /** The line range when the link points at part of a doc (`doc-…#L12-L20`). */
  lines?: LineRef;
  /** The heading when the link points at a section (`doc-…#h=rate-limits`). */
  heading?: HeadingRef;
  /** The visible label between `[` and `]`. May be empty. */
  label: string;
  /** `'transclusion'` if the match started with `!`, else `'link'`. */
  kind: MarkdownRefKind;
  /** Character offset of the start of the full match in the haystack. */
  index: number;
  /** Length of the full matched substring (including any leading `!`). */
  length: number;
}

/**
 * Every markdown reference in `content`, in order, duplicates included: if a
 * node id appears 3 times you get 3 hits. References inside code are skipped.
 */
export function extractMarkdownRefs(content: string): MarkdownRefHit[] {
  const hits: MarkdownRefHit[] = [];
  if (!content) return hits;
  const masked = maskCodeRegions(content);
  const re = new RegExp(MARKDOWN_REF_REGEX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const { id, anchor } = splitDocRef(m[3]!);
    hits.push({
      targetId: id,
      ...(anchor && 'lines' in anchor ? { lines: anchor.lines } : {}),
      ...(anchor && 'heading' in anchor ? { heading: anchor.heading } : {}),
      label: m[2] ?? '',
      kind: m[1] === '!' ? 'transclusion' : 'link',
      index: m.index,
      length: m[0].length,
    });
  }
  return hits;
}

/** Unique target ids referenced in `content`, transclusions and links alike. */
export function extractMarkdownRefIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const hit of extractMarkdownRefs(content)) ids.add(hit.targetId);
  return ids;
}

/**
 * The references whose target looks like a node id, ignoring stray markdown
 * images and links with ordinary URLs that happen to match the regex shape.
 */
export function extractNodeRefs(content: string): MarkdownRefHit[] {
  return extractMarkdownRefs(content).filter((h) => NODE_ID_PREFIX.test(h.targetId));
}

export function extractNodeRefIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const hit of extractNodeRefs(content)) ids.add(hit.targetId);
  return ids;
}

/**
 * Re-point intra-subtree node references when cloning a workspace subtree.
 *
 * `idMap` maps each OLD cloned node id to its NEW counterpart. Every occurrence
 * of a mapped id — inside a chip `[label](doc-…)`, a transclusion
 * `![label](doc-…)`, or a bare `doc-…` / `!doc-…` reference — is rewritten to
 * the clone. Ids not in the map (references pointing out of the copied subtree)
 * are left exactly as-is, so they keep resolving to the originals.
 *
 * Matches are located against a code-masked copy of the content (see
 * `maskCodeRegions`) so ids sitting inside fenced or inline code samples
 * are never rewritten, mirroring how {@link extractMarkdownRefs} and the SQL
 * link trigger treat code regions as inert. The replacements are then spliced
 * back into the ORIGINAL content at the same offsets (masking preserves
 * character positions).
 *
 * The match is boundary-guarded (no id-continuation character on either side),
 * so a mapped id can never partial-match a longer id that merely shares its
 * prefix (`doc-abc` inside `doc-abcd` stays untouched).
 */
export function remapNodeRefs(content: string, idMap: ReadonlyMap<string, string>): string {
  if (!content || idMap.size === 0) return content;
  // Longest ids first so the alternation prefers the most specific match.
  const oldIds = [...idMap.keys()].sort((a, b) => b.length - a.length);
  const alternation = oldIds.map(escapeRegex).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_-])(${alternation})(?![A-Za-z0-9_-])`, 'g');
  const masked = maskCodeRegions(content);
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    out += content.slice(last, m.index);
    out += idMap.get(m[1]) ?? m[1];
    last = m.index + m[0].length;
  }
  out += content.slice(last);
  return out;
}
