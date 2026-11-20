/**
 * Transclusions: `![label](doc-…)` shows another doc's content in place, kept
 * in sync. A `#L…` or `#h=…` fragment narrows it to part of that doc.
 * Server reads, the save-time loop guard and the prompt resolver share this
 * parser, and its label grammar with the editor.
 */

import { splitDocRef, type DocAnchor } from './docHeadingRef';
import { maskCodeRegions } from './markdownCode';

/**
 * A link label as CommonMark reads it (and so the editor): backslash escapes
 * (the editor writes `\[` and `\]` in titles) and balanced brackets one
 * level deep.
 */
export const LINK_LABEL_SOURCE = String.raw`(?:\\.|\[(?:\\.|[^\]\\])*\]|[^[\]\\])*`;

const TRANSCLUSION_SOURCE = String.raw`!\[(${LINK_LABEL_SOURCE})\]\(([^)\s]+)\)`;

export interface TransclusionHit {
  /** The transcluded doc's bare id. */
  docId: string;
  /** The URL as written, fragment included (`doc-…#h=setup`). */
  ref: string;
  /** The part of the doc shown, when the URL has a fragment. */
  anchor: DocAnchor | null;
  label: string;
  /** Offset of the `!` in the content. */
  index: number;
  /** Length of the whole `![label](ref)`. */
  length: number;
}

/** Every transclusion of a doc in `content`, in order. Code is ignored. */
export function findTransclusions(content: string): TransclusionHit[] {
  const hits: TransclusionHit[] = [];
  if (!content || !content.includes('![')) return hits;
  const masked = maskCodeRegions(content);
  const re = new RegExp(TRANSCLUSION_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const ref = m[2]!;
    const { id, anchor } = splitDocRef(ref);
    if (!id.startsWith('doc-')) continue;
    hits.push({
      docId: id,
      ref,
      anchor,
      label: m[1] ?? '',
      index: m.index,
      length: m[0].length,
    });
  }
  return hits;
}

/** The ids of the docs `content` transcludes, each once, in order. */
export function transcludedDocIds(content: string): string[] {
  return [...new Set(findTransclusions(content).map((hit) => hit.docId))];
}
