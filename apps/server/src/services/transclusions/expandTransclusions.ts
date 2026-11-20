/**
 * Expand a doc's transclusions in place for a reader.
 *
 * Each `![label](doc-…)` becomes the transcluded doc's content between
 * `<transcluded-doc id="…" title="…">` and `</transcluded-doc>`, nested
 * transclusions the same way down to MAX_TRANSCLUSION_DEPTH levels. A target
 * that can't be shown becomes one self-closing marker: missing, archived, a
 * part that no longer exists, a loop back to a doc already on the path, a
 * level past the cap, or content past the size budget.
 *
 * The expanded text comes with segments recording, for every span, the doc
 * whose stored text it is and where it sits in that doc. Edit routing maps a
 * match through these positions; it never parses tags back out of the text,
 * so a literal `</transcluded-doc>` inside a doc is just that doc's text.
 */

import { findTransclusions, lineRefOffsets, resolveDocAnchor, unique } from '@snaglet/shared/utils';

const MAX_TRANSCLUSION_DEPTH = 3;

/**
 * At most this many characters of expanded text (about 50k tokens): a read
 * goes into a model's context as one tool result, and a few docs that each
 * transclude the next many times would otherwise multiply into millions of
 * characters. The doc's own text is never cut; a transclusion that would
 * cross the budget becomes a `skipped="size"` marker instead.
 */
export const MAX_EXPANDED_CHARS = 200_000;

export interface TranscludableDoc {
  id: string;
  title: string;
  content: string;
  archived: boolean;
}

/** Loads docs by id; an id missing from the result is a missing doc. */
export type TranscludableDocLoader = (ids: string[]) => Promise<Map<string, TranscludableDoc>>;

/** Why a transclusion shows as a self-closing marker instead of content. */
type MarkerReason = 'missing' | 'archived' | 'missing-part' | 'loop' | 'depth' | 'size';

export interface ExpansionSegment {
  /** Span in the expanded text. */
  start: number;
  end: number;
  /** text: the doc this span belongs to. wrapper: the doc holding the transclusion line. */
  docId: string;
  kind: 'text' | 'wrapper';
  /** Where the span starts in `docId`'s stored content (wrapper: the `![…](…)` line). */
  sourceStart: number;
  /** wrapper: the doc being transcluded. */
  transcludedId?: string;
  /** wrapper: the opening tag, the closing tag, or a self-closing marker. */
  role?: 'open' | 'close' | 'marker';
  /** wrapper: true when the transclusion shows part of the doc (`#h=…`, `#L…`). */
  part?: boolean;
  /** wrapper: that part's fragment as written, `h=setup` or `L3-L9`. */
  fragment?: string;
  /** marker: why nothing is shown. */
  reason?: MarkerReason;
}

export interface Expansion {
  text: string;
  segments: ExpansionSegment[];
  /** Transcluded docs whose own text looks like a `<transcluded-doc>` tag. */
  tagLike: Array<{ id: string; title: string }>;
}

const TAG_LIKE = /<\/?transcluded-doc[\s>/]/;

/** Escape an attribute value so it can neither close the attribute nor the tag. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function openTag(id: string, title: string | null, extra: string[]): string {
  const attrs = [`id="${escapeAttr(id)}"`];
  if (title !== null) attrs.push(`title="${escapeAttr(title)}"`);
  return `<transcluded-doc ${[...attrs, ...extra].join(' ')}`;
}

const MARKER_ATTR: Record<MarkerReason, string> = {
  missing: 'missing="true"',
  archived: 'archived="true"',
  'missing-part': 'missing="part"',
  loop: 'skipped="loop"',
  depth: 'skipped="depth"',
  size: 'skipped="size"',
};

export async function expandTransclusions(
  root: { id: string; content: string },
  load: TranscludableDocLoader,
  opts: { maxDepth?: number; maxChars?: number } = {}
): Promise<Expansion> {
  const maxDepth = opts.maxDepth ?? MAX_TRANSCLUSION_DEPTH;
  const maxChars = opts.maxChars ?? MAX_EXPANDED_CHARS;
  const cache = new Map<string, TranscludableDoc | null>();
  const tagLike = new Map<string, string>();
  const parts: string[] = [];
  const segments: ExpansionSegment[] = [];
  let length = 0;

  const append = (text: string, segment: Omit<ExpansionSegment, 'start' | 'end'>): void => {
    segments.push({ ...segment, start: length, end: length + text.length });
    parts.push(text);
    length += text.length;
  };

  // A run of size markers with only whitespace between them becomes one
  // marker with a count; the whitespace waits in `held` until the run ends.
  let run: { part: number; segment: ExpansionSegment; count: number } | null = null;
  let held: Array<[string, Omit<ExpansionSegment, 'start' | 'end'>]> = [];
  const endRun = () => {
    run = null;
    const waiting = held;
    held = [];
    for (const [text, segment] of waiting) append(text, segment);
  };

  const push = (text: string, segment: Omit<ExpansionSegment, 'start' | 'end'>): void => {
    if (!text) return;
    if (run) {
      if (segment.kind === 'text' && text.trim() === '') {
        held.push([text, segment]);
        return;
      }
      endRun();
    }
    append(text, segment);
  };

  /**
   * Mark a transclusion skipped for size. Markers count against the budget
   * too: one that would not fit, with the `tail` of stored text still to
   * come, keeps the transclusion's own line instead.
   */
  const sizeMarker = (
    line: string,
    tag: string,
    tail: number,
    segment: Omit<ExpansionSegment, 'start' | 'end'>
  ) => {
    if (run) {
      held = [];
      run.count += 1;
      const text = `<transcluded-doc skipped="size" count="${run.count}"/>`;
      length += text.length - parts[run.part]!.length;
      parts[run.part] = text;
      run.segment.end = run.segment.start + text.length;
      return;
    }
    push(length + tag.length + tail > maxChars ? line : tag, {
      ...segment,
      role: 'marker',
      reason: 'size',
    });
    run = { part: parts.length - 1, segment: segments[segments.length - 1]!, count: 1 };
  };

  const fetch = async (ids: string[]): Promise<void> => {
    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length === 0) return;
    const found = await load(missing);
    for (const id of missing) cache.set(id, found.get(id) ?? null);
  };

  /**
   * Emit `content` from `from` to `to`. Transclusions are found in the whole
   * doc, so code that opens before a part still masks what is inside it.
   * `reserve` is the stored text the levels above still have to emit after
   * this one, so a nested expansion can't spend the budget their text needs.
   */
  const walk = async (
    docId: string,
    content: string,
    from: number,
    to: number,
    chain: readonly string[],
    depth: number,
    reserve: number
  ): Promise<void> => {
    const hits = findTransclusions(content).filter(
      (hit) => hit.index >= from && hit.index + hit.length <= to
    );
    await fetch(unique(hits.map((hit) => hit.docId)));
    let cursor = from;
    for (const hit of hits) {
      push(content.slice(cursor, hit.index), { docId, kind: 'text', sourceStart: cursor });
      cursor = hit.index + hit.length;
      const hash = hit.ref.indexOf('#');
      const part = hit.anchor !== null && hash >= 0;
      const partAttr = part ? [`part="${escapeAttr(hit.ref.slice(hash + 1))}"`] : [];
      const wrapper = {
        docId,
        kind: 'wrapper' as const,
        sourceStart: hit.index,
        transcludedId: hit.docId,
        part,
        ...(part ? { fragment: hit.ref.slice(hash + 1) } : {}),
      };
      const target = cache.get(hit.docId) ?? null;
      const marker = (reason: MarkerReason) =>
        push(`${openTag(hit.docId, target?.title ?? null, [...partAttr, MARKER_ATTR[reason]])}/>`, {
          ...wrapper,
          role: 'marker',
          reason,
        });
      if (!target) {
        marker('missing');
        continue;
      }
      if (target.archived) {
        marker('archived');
        continue;
      }
      if (chain.includes(target.id)) {
        marker('loop');
        continue;
      }
      if (depth >= maxDepth) {
        marker('depth');
        continue;
      }
      let body = { start: 0, end: target.content.length };
      if (hit.anchor) {
        const resolved = resolveDocAnchor(target.content, hit.anchor);
        const range = resolved.lines ? lineRefOffsets(target.content, resolved.lines) : null;
        if (!range) {
          marker('missing-part');
          continue;
        }
        body = range;
      }
      const open = `${openTag(target.id, target.title, partAttr)}>\n`;
      const close = '\n</transcluded-doc>';
      const tail = reserve + (to - cursor);
      if (length + open.length + (body.end - body.start) + close.length + tail > maxChars) {
        sizeMarker(
          content.slice(hit.index, hit.index + hit.length),
          `${openTag(target.id, target.title, [...partAttr, MARKER_ATTR.size])}/>`,
          tail,
          wrapper
        );
        continue;
      }
      if (TAG_LIKE.test(target.content.slice(body.start, body.end))) {
        tagLike.set(target.id, target.title);
      }
      push(open, { ...wrapper, role: 'open' });
      await walk(
        target.id,
        target.content,
        body.start,
        body.end,
        [...chain, target.id],
        depth + 1,
        tail
      );
      push(close, { ...wrapper, role: 'close' });
    }
    push(content.slice(cursor, to), { docId, kind: 'text', sourceStart: cursor });
  };

  await walk(root.id, root.content, 0, root.content.length, [root.id], 0, 0);
  endRun();
  return {
    text: parts.join(''),
    segments,
    tagLike: [...tagLike].map(([id, title]) => ({ id, title })),
  };
}
