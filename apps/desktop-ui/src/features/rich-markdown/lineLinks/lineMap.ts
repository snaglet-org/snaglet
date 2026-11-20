// lineMap.ts — doc line links ↔ the rich editor's blocks.
//
// A line link (`doc-…#L12-L20`) counts raw markdown lines; the editor
// shows ProseMirror blocks. Both come from the same markdown-it token
// stream, so the Nth textblock in the editor is the Nth paragraph /
// heading / code token, and that token's `map` holds its source lines.
// Char-precise ends are matched by text; when the text can't be found
// (inline markup, chips) the link falls back to whole lines.

import type { Node as PMNode } from '@tiptap/pm/model';
import type { LineRef } from '@snaglet/shared/utils';
import { richMarkdownBlockTokens } from '../editor/richMarkdown';

/** Source lines of one editor textblock (1-indexed, inclusive). */
export interface BlockLines {
  start: number;
  end: number;
}

interface Textblock {
  node: PMNode;
  pos: number;
}

const TEXTBLOCK_TOKENS = new Set(['paragraph_open', 'heading_open', 'code_block', 'fence']);
/** Shortest text probe used to pin a char-precise end. */
const PROBE = 24;

/**
 * True when the editor fills in an empty paragraph the tokens don't have: a
 * list item must open with one (an empty `1. `, or `- - nested`), and a quote
 * needs some block (a bare `>`).
 */
function editorAddsParagraph(type: string, next: string | undefined): boolean {
  if (type === 'list_item_open') return next !== 'paragraph_open';
  return type === 'blockquote_open' && next === 'blockquote_close';
}

/** Source lines for each textblock the rich editor will build, in doc order. */
export function markdownBlockLines(markdown: string): Array<BlockLines | null> {
  const out: Array<BlockLines | null> = [];
  let rowMap: [number, number] | null = null;
  const tokens = richMarkdownBlockTokens(markdown);
  tokens.forEach((token, i) => {
    if (token.type === 'tr_open' && token.map) rowMap = token.map as [number, number];
    if (editorAddsParagraph(token.type, tokens[i + 1]?.type)) {
      const line = token.map ? token.map[0] + 1 : null;
      out.push(line === null ? null : { start: line, end: line });
      return;
    }
    if (!TEXTBLOCK_TOKENS.has(token.type)) return;
    // Table cells get synthetic paragraphs without a map: use their row's.
    const map = (token.map as [number, number] | null) ?? rowMap;
    out.push(map ? { start: map[0] + 1, end: Math.max(map[0] + 1, map[1]) } : null);
  });
  return out;
}

export function textblocks(doc: PMNode): Textblock[] {
  const out: Textblock[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  return out;
}

/** Document position at `offset` characters into a textblock's text. */
function posAtTextOffset(block: Textblock, offset: number): number {
  let acc = 0;
  let found: number | null = null;
  block.node.forEach((child, childOffset) => {
    if (found !== null || !child.isText) return;
    const len = child.text?.length ?? 0;
    if (offset <= acc + len) found = block.pos + 1 + childOffset + (offset - acc);
    acc += len;
  });
  return found ?? block.pos + block.node.nodeSize - 1;
}

/** Characters of text before `pos` inside a textblock. */
function textOffsetAt(block: Textblock, pos: number): number {
  let acc = 0;
  block.node.forEach((child, childOffset) => {
    if (!child.isText) return;
    const start = block.pos + 1 + childOffset;
    const len = child.text?.length ?? 0;
    if (pos >= start + len) acc += len;
    else if (pos > start) acc += pos - start;
  });
  return acc;
}

/** Soft breaks render as spaces in the editor; same length, so offsets hold. */
const flat = (s: string) => s.replace(/\n/g, ' ');

function nthIndexOf(haystack: string, needle: string, n: number): number {
  let idx = -1;
  for (let i = 0; i <= n; i++) {
    idx = haystack.indexOf(needle, idx + 1);
    if (idx < 0) return -1;
  }
  return idx;
}

function countBefore(haystack: string, needle: string, end: number): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0 && idx < end) {
    n++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return n;
}

/** Line + col (1-indexed) of `offset` inside the source lines of a block. */
function lineColAt(src: string, firstLine: number, offset: number) {
  const before = src.slice(0, offset);
  const line = firstLine + (before.match(/\n/g)?.length ?? 0);
  const col = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

/** Offset of (line, col0) inside the source of a block starting at `blockStart`. */
function offsetInBlock(src: string[], blockStart: number, line: number, col0: number): number {
  let off = 0;
  for (let k = blockStart; k < line; k++) off += (src[k - 1]?.length ?? 0) + 1;
  return off + col0;
}

const PROBES = [PROBE, 16, 8, 4, 2, 1];

/**
 * Where in a block's rendered text a link end lands. Markup only ever adds
 * characters, so the rendered offset is at most the source offset: take the
 * matching probe closest to (and not past) it. `head` probes read forward
 * from the start; `tail` probes read back from the end and return the end.
 * Shorter probes are tried when markup (`- `, `**`) breaks a long one.
 */
function locate(text: string, probeSrc: string, srcOff: number, side: 'head' | 'tail'): number {
  for (const n of PROBES) {
    const probe = side === 'head' ? probeSrc.slice(0, n) : probeSrc.slice(-n);
    if (!probe.trim()) continue;
    const flatProbe = flat(probe);
    let best = -1;
    let idx = text.indexOf(flatProbe);
    while (idx >= 0) {
      const at = side === 'head' ? idx : idx + flatProbe.length;
      if (at <= srcOff) best = at;
      else break;
      idx = text.indexOf(flatProbe, idx + 1);
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** The editor range a line link covers, or null when it points past the doc. */
export function rangeForLines(
  doc: PMNode,
  markdown: string,
  lines: LineRef
): { from: number; to: number } | null {
  const blocks = textblocks(doc);
  const map = markdownBlockLines(markdown);
  const hits: number[] = [];
  for (let i = 0; i < Math.min(blocks.length, map.length); i++) {
    const m = map[i];
    if (m && m.end >= lines.startLine && m.start <= lines.endLine) hits.push(i);
  }
  if (hits.length === 0) return null;
  const first = blocks[hits[0]];
  const last = blocks[hits[hits.length - 1]];
  let from = first.pos + 1;
  let to = last.pos + last.node.nodeSize - 1;

  if (lines.startChar != null && lines.endChar != null) {
    const src = markdown.split('\n');
    const a = map[hits[0]]!;
    const z = map[hits[hits.length - 1]]!;
    // Offsets into each block's own source, where the link's ends sit.
    const startSrcOff = offsetInBlock(src, a.start, lines.startLine, lines.startChar - 1);
    const endSrcOff = offsetInBlock(src, z.start, lines.endLine, lines.endChar);
    const startLine = src[lines.startLine - 1] ?? '';
    const endLine = (src[lines.endLine - 1] ?? '').slice(0, lines.endChar);
    const startIdx = locate(
      flat(first.node.textContent),
      startLine.slice(lines.startChar - 1),
      startSrcOff,
      'head'
    );
    const endIdx = locate(flat(last.node.textContent), endLine, endSrcOff, 'tail');
    if (startIdx >= 0) from = posAtTextOffset(first, startIdx);
    if (endIdx >= 0) to = posAtTextOffset(last, endIdx);
    if (to <= from) return { from: first.pos + 1, to: last.pos + last.node.nodeSize - 1 };
  }
  return { from, to };
}

/**
 * The line link for an editor selection: whole lines when the selection
 * covers whole blocks or its text can't be found in the source, otherwise
 * char-precise.
 */
export function linesForSelection(
  doc: PMNode,
  markdown: string,
  from: number,
  to: number
): LineRef | null {
  if (to <= from) return null;
  const blocks = textblocks(doc);
  const map = markdownBlockLines(markdown);
  const n = Math.min(blocks.length, map.length);
  let i = -1;
  let j = -1;
  for (let k = 0; k < n; k++) {
    const b = blocks[k];
    const end = b.pos + b.node.nodeSize;
    if (i < 0 && end > from) i = k;
    if (b.pos < to) j = k;
  }
  if (i < 0 || j < 0 || j < i) return null;
  const a = map[i];
  const z = map[j];
  if (!a || !z) return null;
  const whole: LineRef = { startLine: a.start, endLine: z.end };

  const startBlock = blocks[i];
  const endBlock = blocks[j];
  const startText = flat(startBlock.node.textContent);
  const endText = flat(endBlock.node.textContent);
  const startOff = Math.max(0, textOffsetAt(startBlock, from));
  const endOff = Math.min(endText.length, textOffsetAt(endBlock, to));
  if (startOff === 0 && endOff >= endText.length) return whole;

  const lines = markdown.split('\n');
  const srcOf = (m: BlockLines) => flat(lines.slice(m.start - 1, m.end).join('\n'));
  const rawOf = (m: BlockLines) => lines.slice(m.start - 1, m.end).join('\n');

  const head = startText.slice(startOff, i === j ? endOff : undefined).slice(0, PROBE);
  const tailFrom = i === j ? startOff : 0;
  const tail = endText.slice(tailFrom, endOff).slice(-PROBE);
  if (!head.trim() || !tail.trim()) return whole;

  const headIdx = nthIndexOf(srcOf(a), head, countBefore(startText, head, startOff));
  const tailStart = endOff - tail.length;
  const tailIdx = nthIndexOf(srcOf(z), tail, countBefore(endText, tail, tailStart));
  if (headIdx < 0 || tailIdx < 0) return whole;

  const s = lineColAt(rawOf(a), a.start, headIdx);
  const e = lineColAt(rawOf(z), z.start, tailIdx + tail.length - 1);
  if (e.line < s.line || (e.line === s.line && e.col < s.col)) return whole;
  return { startLine: s.line, endLine: e.line, startChar: s.col, endChar: e.col };
}

/** Line link for a plain-text (source mode) selection: exact offsets. */
export function linesForSourceSelection(
  markdown: string,
  start: number,
  end: number
): LineRef | null {
  if (end <= start) return null;
  const s = lineColAt(markdown, 1, start);
  // `end` is exclusive; the link's end char is inclusive.
  const e = lineColAt(markdown, 1, end - 1);
  const lines = markdown.split('\n');
  const endLineLen = lines[e.line - 1]?.length ?? 0;
  if (s.col === 1 && (e.col >= endLineLen || endLineLen === 0)) {
    return { startLine: s.line, endLine: e.line };
  }
  return { startLine: s.line, endLine: e.line, startChar: s.col, endChar: e.col };
}

/** Source offsets [start, end) a line link covers, for selecting it in a textarea. */
export function sourceOffsetsForLines(markdown: string, ref: LineRef): [number, number] | null {
  const lines = markdown.split('\n');
  if (ref.startLine > lines.length) return null;
  const endLine = Math.min(ref.endLine, lines.length);
  let start = 0;
  for (let k = 0; k < ref.startLine - 1; k++) start += lines[k].length + 1;
  let end = start;
  for (let k = ref.startLine - 1; k < endLine; k++) end += lines[k].length + 1;
  end -= 1;
  if (ref.startChar != null && ref.endChar != null) {
    const endLineStart = end - lines[endLine - 1].length;
    return [start + ref.startChar - 1, Math.min(end, endLineStart + ref.endChar)];
  }
  return [start, end];
}

/**
 * Editor position of every heading block, by its source line. Only this
 * doc's own blocks are walked: a transcluded doc renders inside an atom chip,
 * so its headings are never here.
 */
export function headingBlockPositions(doc: PMNode, markdown: string): Map<number, number> {
  const blocks = textblocks(doc);
  const map = markdownBlockLines(markdown);
  const out = new Map<number, number>();
  for (let i = 0; i < Math.min(blocks.length, map.length); i++) {
    const line = map[i]?.start;
    if (line !== undefined && blocks[i]!.node.type.name === 'heading')
      out.set(line, blocks[i]!.pos);
  }
  return out;
}

/** Source line of the heading textblock at `pos`, or null if it isn't one. */
export function headingLineAtPos(doc: PMNode, markdown: string, pos: number): number | null {
  const blocks = textblocks(doc);
  const map = markdownBlockLines(markdown);
  for (let i = 0; i < Math.min(blocks.length, map.length); i++) {
    const b = blocks[i]!;
    if (pos >= b.pos && pos <= b.pos + b.node.nodeSize) {
      return b.node.type.name === 'heading' ? (map[i]?.start ?? null) : null;
    }
  }
  return null;
}
