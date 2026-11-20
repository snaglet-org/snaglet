/**
 * Route find/replace edits through a doc's transclusions.
 *
 * Each edit's old_text is matched against the same expanded text a read
 * returns. A match inside one transcluded doc's text edits THAT doc, at the
 * position the expansion recorded for it; a match in the doc's own text edits
 * the doc. A match that crosses from one doc's text into another's, or touches
 * a `<transcluded-doc>` tag, is refused. Text found only in the doc's stored
 * source (a `![title](doc-id)` line) edits that source, so transclusions can
 * be added, removed and retargeted. With `raw`, edits match the stored source
 * only.
 *
 * Edits apply in order, each against the result of the ones before it. The
 * doc is expanded once per batch; an edit that leaves every transclusion line
 * where it was is patched into that expansion, and only one that adds,
 * removes or moves a transclusion, or changes a doc shown in part, makes it
 * expand again. The caller writes the changed docs.
 */

import { findTransclusions } from '@snaglet/shared/utils';
import {
  expandTransclusions,
  type Expansion,
  type ExpansionSegment,
  type TranscludableDoc,
  type TranscludableDocLoader,
} from './expandTransclusions';

export interface EditChange {
  old_text: string;
  new_text: string;
  occurrence?: number;
  context_before?: string;
  context_after?: string;
}

export interface RoutedEdit {
  index: number;
  /** The doc this edit changed. */
  doc_id: string;
  occurrences_found: number;
  /** Offset of the change in that doc's stored content. */
  applied_at: number;
}

export interface RoutedEdits {
  /** Content after the batch, for each doc it changes, in the order first changed. */
  changed: Map<string, string>;
  /** Content before the batch, for the same docs. */
  original: Map<string, string>;
  titles: Map<string, string>;
  applied: RoutedEdit[];
}

/**
 * Find all occurrences of `needle` in `haystack` and return their indices.
 * Supports optional context_before / context_after disambiguation.
 */
function findOccurrences(
  haystack: string,
  needle: string,
  contextBefore?: string,
  contextAfter?: string
): number[] {
  const indices: number[] = [];
  if (!needle) return indices;
  let from = 0;
  while (from <= haystack.length) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    let ok = true;
    if (contextBefore) {
      const before = haystack.slice(Math.max(0, i - contextBefore.length), i);
      if (!before.endsWith(contextBefore)) ok = false;
    }
    if (ok && contextAfter) {
      const after = haystack.slice(i + needle.length, i + needle.length + contextAfter.length);
      if (!after.startsWith(contextAfter)) ok = false;
    }
    if (ok) indices.push(i);
    from = i + Math.max(1, needle.length);
  }
  return indices;
}

// Self-teaching diagnostics for a failed match. When old_text isn't found,
// the cause is almost always whitespace/formatting drift between what the
// agent THINKS the doc says and the real bytes. Surface the nearest real
// anchor so the agent fixes it in one retry instead of blind-retrying.
function nearestAnchor(haystack: string, needle: string): string {
  if (!needle || !haystack) return '';
  for (let len = Math.min(needle.length, 40); len >= 8; len -= 4) {
    const at = haystack.indexOf(needle.slice(0, len));
    if (at !== -1) {
      const real = haystack
        .slice(at, Math.min(haystack.length, at + needle.length + 20))
        .replace(/\n/g, '\\n');
      return ` Nearest real text in doc: "${real.slice(0, 120)}" — copy it EXACTLY (note whitespace/newlines).`;
    }
  }
  const firstWord = needle.trim().split(/\s+/)[0] || '';
  const at = firstWord ? haystack.indexOf(firstWord) : -1;
  if (at !== -1) {
    const real = haystack.slice(at, Math.min(haystack.length, at + 100)).replace(/\n/g, '\\n');
    return ` Closest doc text containing "${firstWord}": "${real.slice(0, 100)}".`;
  }
  return ` No part of old_text appears in the doc — re-read the doc with get_doc and copy the exact current text.`;
}

// Short context snippet around a match index, for disambiguating ambiguous
// edits without forcing the agent to re-fetch the whole doc.
function matchContext(haystack: string, index: number, needleLen: number): string {
  const start = Math.max(0, index - 25);
  const end = Math.min(haystack.length, index + needleLen + 25);
  return haystack.slice(start, end).replace(/\n/g, '\\n').slice(0, 90);
}

const SEPARATELY =
  'Edit each doc separately, or pass raw: true to change the transclusion line itself.';

/** True when `after` has the same transclusion lines as `before`, moved only by the edit. */
function sameTransclusions(
  before: string,
  after: string,
  offset: number,
  oldLength: number,
  newLength: number
): boolean {
  const was = findTransclusions(before);
  const now = findTransclusions(after);
  if (was.length !== now.length) return false;
  const delta = newLength - oldLength;
  return was.every((hit, n) => {
    const next = now[n]!;
    if (hit.index < offset + oldLength && hit.index + hit.length > offset) return false;
    const index = hit.index >= offset + oldLength ? hit.index + delta : hit.index;
    return next.index === index && next.ref === hit.ref && next.length === hit.length;
  });
}

/**
 * Apply one edit of `docId`'s stored text to an expansion in place: every
 * copy of the doc shown gets the new text, and the positions after it move.
 * Returns false, leaving the expansion untouched, when it must be rebuilt.
 */
function patchExpansion(
  expansion: Expansion,
  docId: string,
  edit: { offset: number; oldText: string; newText: string; before: string; after: string }
): boolean {
  const { offset, oldText, newText } = edit;
  const end = offset + oldText.length;
  if (!sameTransclusions(edit.before, edit.after, offset, oldText.length, newText.length)) {
    return false;
  }
  const { segments } = expansion;
  if (segments.some((s) => s.kind === 'wrapper' && s.transcludedId === docId && s.part)) {
    return false;
  }
  const holds = (s: ExpansionSegment) =>
    s.sourceStart <= offset && end <= s.sourceStart + (s.end - s.start);
  for (const s of segments) {
    if (s.kind !== 'text' || s.docId !== docId) continue;
    const overlaps = s.sourceStart < end && s.sourceStart + (s.end - s.start) > offset;
    if (overlaps && !holds(s)) return false;
  }
  const delta = newText.length - oldText.length;
  const cuts: number[] = [];
  let shift = 0;
  for (const s of segments) {
    const start = s.start;
    const length = s.end - s.start;
    let grow = 0;
    if (s.docId === docId) {
      if (s.kind === 'text' && holds(s)) {
        cuts.push(start + (offset - s.sourceStart));
        grow = delta;
      } else if (s.sourceStart >= end) {
        s.sourceStart += delta;
      }
    }
    s.start = start + shift;
    s.end = s.start + length + grow;
    shift += grow;
  }
  let text = '';
  let from = 0;
  for (const cut of cuts) {
    text += expansion.text.slice(from, cut) + newText;
    from = cut + oldText.length;
  }
  expansion.text = text + expansion.text.slice(from);
  return true;
}

/** Where one match lands: a spot in one doc's stored text, or a refusal. */
type Resolution =
  | { kind: 'doc'; docId: string; offset: number; at: number }
  | { kind: 'refused'; reason: string; at: number };

export async function routeEdits(opts: {
  root: { id: string; title: string; content: string };
  edits: EditChange[];
  /** Stored docs; the batch's pending contents are layered on top. */
  load: TranscludableDocLoader;
  raw: boolean;
}): Promise<RoutedEdits> {
  const { root, edits, load, raw } = opts;
  const working = new Map<string, string>([[root.id, root.content]]);
  const original = new Map<string, string>();
  const titles = new Map<string, string>([[root.id, root.title]]);
  const known = new Map<string, TranscludableDoc>();
  const applied: RoutedEdit[] = [];

  const overlay: TranscludableDocLoader = async (ids) => {
    const found = await load(ids);
    const out = new Map<string, TranscludableDoc>();
    for (const [id, doc] of found) {
      known.set(id, doc);
      titles.set(id, doc.title);
      const pending = working.get(id);
      out.set(id, pending === undefined ? doc : { ...doc, content: pending });
    }
    return out;
  };

  const label = (docId: string) => `"${titles.get(docId) ?? docId}" (${docId})`;

  let expansion: Expansion | null = null;
  const expanded = async (): Promise<Expansion> =>
    (expansion ??= await expandTransclusions(
      { id: root.id, content: working.get(root.id)! },
      overlay
    ));

  const write = (docId: string, offset: number, oldText: string, newText: string) => {
    const before = working.get(docId) ?? known.get(docId)?.content ?? '';
    if (before.slice(offset, offset + oldText.length) !== oldText) {
      throw new Error(`edit routing: text at ${docId}:${offset} no longer matches`);
    }
    if (!original.has(docId)) original.set(docId, before);
    const after = before.slice(0, offset) + newText + before.slice(offset + oldText.length);
    working.set(docId, after);
    if (
      expansion &&
      !patchExpansion(expansion, docId, { offset, oldText, newText, before, after })
    ) {
      expansion = null;
    }
  };

  const outOfRange = (i: number, e: EditChange, found: number) =>
    new Error(`Edit ${i}: occurrence ${e.occurrence} out of range (found ${found})`);

  /**
   * Which matches an edit changes. `occurrence` counts every match in
   * reading order, the copies of a doc shown twice included, so the number
   * is the one the agent sees; whether the text is ambiguous depends on how
   * many different places those matches are. -1 takes every place.
   */
  const choose = <T extends { at: number; key: string }>(
    i: number,
    e: EditChange,
    matches: T[],
    describe: (match: T) => { where: string; context: string },
    opts: { hint?: string; everyPlace?: (match: T) => boolean } = {}
  ): T[] => {
    const places: T[] = [];
    const firstAt = new Map<string, number>();
    matches.forEach((match, n) => {
      if (firstAt.has(match.key)) return;
      firstAt.set(match.key, n);
      places.push(match);
    });
    if (e.occurrence === -1) return places.filter(opts.everyPlace ?? (() => true));
    if (typeof e.occurrence === 'number') {
      const match = matches[e.occurrence - 1];
      if (!match || e.occurrence < 1) throw outOfRange(i, e, matches.length);
      return [match];
    }
    if (places.length > 1) {
      const previews = matches
        .slice(0, 6)
        .map((match, n) => {
          const first = firstAt.get(match.key)!;
          const same = first === n ? '' : `, the same text as occurrence ${first + 1}`;
          const { where, context } = describe(match);
          return `  occurrence ${n + 1}${where}${same}: "…${context}…"`;
        })
        .join('\n');
      const count =
        places.length < matches.length
          ? `${matches.length} matches, ${places.length} places`
          : `${matches.length} matches`;
      throw new Error(
        `Edit ${i}: text is ambiguous (${count}). Provide "occurrence" (1-${matches.length}, ` +
          `or -1 for all) or context_before/context_after to disambiguate.\n${previews}` +
          (opts.hint ? `\n${opts.hint}` : '')
      );
    }
    return places;
  };

  /** Apply one edit at several places in one doc, last first so offsets hold. */
  const writeAll = (i: number, docId: string, offsets: number[], e: EditChange) => {
    const sorted = [...offsets].sort((a, b) => b - a);
    for (let n = 1; n < sorted.length; n++) {
      if (sorted[n]! + e.old_text.length > sorted[n - 1]!) {
        throw new Error(
          `Edit ${i}: matches overlap in ${label(docId)}; use "occurrence" to pick one.`
        );
      }
    }
    for (const offset of sorted) write(docId, offset, e.old_text, e.new_text);
  };

  const resolve = (segments: ExpansionSegment[], at: number, length: number): Resolution => {
    const end = at + length;
    const touched = segments.filter((s) => s.start < end && s.end > at);
    const tags = touched.filter((s) => s.kind === 'wrapper');
    if (tags.length > 0) {
      const tag = tags[0]!;
      return {
        kind: 'refused',
        at,
        reason:
          `old_text includes part of the <transcluded-doc> tag that shows ` +
          `${label(tag.transcludedId!)} in ${label(tag.docId)}; the tag belongs to neither doc. ${SEPARATELY}`,
      };
    }
    const owners = [...new Set(touched.map((s) => s.docId))];
    if (owners.length > 1) {
      return {
        kind: 'refused',
        at,
        reason: `old_text runs across text from ${owners.map(label).join(' and ')}, so no one doc holds it. ${SEPARATELY}`,
      };
    }
    const seg = touched[0]!;
    return { kind: 'doc', docId: seg.docId, offset: seg.sourceStart + (at - seg.start), at };
  };

  /**
   * Transcluded docs that hold `needle` in text this doc does not show, and
   * why it is hidden, so a not-found error can point at the right doc.
   */
  const hiddenHolders = async (
    segments: ExpansionSegment[],
    needle: string,
    afterEarlierEdits: boolean
  ): Promise<string[]> => {
    const tags = segments.filter((s) => s.role === 'marker' || (s.role === 'open' && s.part));
    const docs = await overlay([...new Set(tags.map((s) => s.transcludedId!))]);
    const notes = new Map<string, string>();
    for (const tag of tags) {
      const doc = docs.get(tag.transcludedId!);
      if (!doc || notes.has(doc.id) || !doc.content.includes(needle)) continue;
      const part = `its "${tag.fragment}" part`;
      const why: Record<string, string> = {
        archived:
          'it is archived, so this doc does not show it; edit that doc directly with allow_archived: true',
        'missing-part': `this doc shows only ${part}, which no longer exists${
          afterEarlierEdits ? ' after an earlier edit in this batch' : ''
        }; edit that doc directly, or fix the transclusion line with raw: true`,
        loop: 'this doc does not show it again, since that would loop; edit that doc directly',
        depth:
          'it is more than three transclusions deep, so this doc does not show it; edit that doc directly',
        size: 'it is past the size limit of a read, so this doc does not show it; edit that doc directly',
        part: `this doc shows only ${part}, and the text is outside it; edit that doc directly`,
      };
      const note = why[tag.role === 'marker' ? tag.reason! : 'part'];
      if (note) notes.set(doc.id, `${label(doc.id)} has it, but ${note}.`);
    }
    return [...notes.values()];
  };

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    if (typeof e.old_text !== 'string' || typeof e.new_text !== 'string') {
      throw new Error(`Edit ${i}: old_text and new_text must be strings`);
    }
    const rootContent = working.get(root.id)!;
    // Pure insert (empty old_text) is a first write into an empty doc; with
    // no anchor there is no defined position in a non-empty one.
    if (e.old_text.length === 0) {
      if (rootContent.length > 0) {
        throw new Error(`Edit ${i}: pure insert (empty old_text) is only supported on empty docs`);
      }
      write(root.id, 0, '', e.new_text);
      applied.push({ index: i, doc_id: root.id, occurrences_found: 0, applied_at: 0 });
      continue;
    }

    const applyToSource = (occurrences: number[]) => {
      const chosen = choose(
        i,
        e,
        occurrences.map((at) => ({ at, key: String(at) })),
        (m) => ({ where: '', context: matchContext(rootContent, m.at, e.old_text.length) })
      );
      writeAll(
        i,
        root.id,
        chosen.map((m) => m.at),
        e
      );
      for (const m of chosen) {
        applied.push({
          index: i,
          doc_id: root.id,
          occurrences_found: occurrences.length,
          applied_at: m.at,
        });
      }
    };

    const sourceHits = () =>
      findOccurrences(rootContent, e.old_text, e.context_before, e.context_after);
    const withContext = e.context_before || e.context_after ? ' with given context' : '';

    if (raw) {
      const hits = sourceHits();
      if (hits.length === 0) {
        throw new Error(
          `Edit ${i}: text not found${withContext}.${nearestAnchor(rootContent, e.old_text)}`
        );
      }
      applyToSource(hits);
      continue;
    }

    const { text: shown, segments } = await expanded();
    const hits = findOccurrences(shown, e.old_text, e.context_before, e.context_after);
    if (hits.length === 0) {
      // A `![title](doc-id)` line exists only in the stored source.
      const source = sourceHits();
      if (source.length > 0) {
        applyToSource(source);
        continue;
      }
      const hidden = await hiddenHolders(segments, e.old_text, applied.length > 0);
      if (hidden.length > 0) {
        throw new Error(`Edit ${i}: text not found in what this doc shows. ${hidden.join(' ')}`);
      }
      throw new Error(
        `Edit ${i}: text not found${withContext}.${nearestAnchor(shown, e.old_text)}`
      );
    }

    // `line`: in a transclusion line of the stored source, which a read does not show.
    type Match = Resolution & { key: string; line?: true };
    const matches: Match[] = hits.map((at) => {
      const r = resolve(segments, at, e.old_text.length);
      // The same doc text shown twice (a doc transcluded twice) is one place.
      return { ...r, key: r.kind === 'doc' ? `${r.docId}:${r.offset}` : `refused:${at}` };
    });
    // Text inside a `![title](doc-id)` line (its label, say) is in the stored
    // source but not in what a read shows. When a shown match would send the
    // edit to another doc, it counts after the shown matches, so the edit is
    // ambiguous rather than silently going elsewhere.
    const elsewhere = matches.some((m) => m.kind === 'doc' && m.docId !== root.id);
    const lines = elsewhere ? findTransclusions(rootContent) : [];
    for (const at of elsewhere ? sourceHits() : []) {
      const end = at + e.old_text.length;
      if (!lines.some((hit) => hit.index < end && hit.index + hit.length > at)) continue;
      matches.push({ kind: 'doc', docId: root.id, offset: at, at, key: `line:${at}`, line: true });
    }
    const chosen = choose(
      i,
      e,
      matches,
      (m) =>
        m.line
          ? {
              where: ` in the stored source of ${label(root.id)}, inside a transclusion line`,
              context: matchContext(rootContent, m.at, e.old_text.length),
            }
          : {
              where: m.kind === 'doc' ? ` in ${label(m.docId)}` : ' across a tag',
              context: matchContext(shown, m.at, e.old_text.length),
            },
      {
        everyPlace: (m) => !m.line,
        hint: matches.some((m) => m.line)
          ? 'A match "inside a transclusion line" is part of a `![title](doc-id)` line, which a read does not show; to change that line itself, pass raw: true.'
          : undefined,
      }
    );
    const refused = chosen.find((m) => m.kind === 'refused');
    if (refused?.kind === 'refused') throw new Error(`Edit ${i}: ${refused.reason}`);
    const byDoc = new Map<string, number[]>();
    for (const m of chosen) {
      if (m.kind !== 'doc') continue;
      byDoc.set(m.docId, [...(byDoc.get(m.docId) ?? []), m.offset]);
    }
    for (const [docId, offsets] of byDoc) {
      writeAll(i, docId, offsets, e);
      for (const offset of offsets) {
        applied.push({
          index: i,
          doc_id: docId,
          occurrences_found: matches.length,
          applied_at: offset,
        });
      }
    }
  }

  const changed = new Map<string, string>();
  for (const docId of original.keys()) changed.set(docId, working.get(docId)!);
  return { changed, original, titles, applied };
}
