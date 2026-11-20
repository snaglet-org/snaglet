// Carries the selection across the doc editor's rendered ↔ markdown switch.
// The line-link map (`lineLinks/lineMap.ts`) already matches editor blocks to
// source lines, char-precise where the text can be found; a caret is mapped
// as a one-character selection next to it.

import type { Node as PMNode } from '@tiptap/pm/model';

import {
  linesForSelection,
  linesForSourceSelection,
  rangeForLines,
  sourceOffsetsForLines,
} from '../lineLinks/lineMap';

/** Source offsets [start, end) for an editor selection, or null. */
export function richToSourceSelection(
  doc: PMNode,
  markdown: string,
  from: number,
  to: number
): [number, number] | null {
  const offsets = (a: number, b: number) => {
    const ref = linesForSelection(doc, markdown, a, b);
    return ref ? sourceOffsetsForLines(markdown, ref) : null;
  };
  if (to > from) return offsets(from, to);
  const size = doc.content.size;
  // A caret: map the character after it, else the one before it.
  const after =
    from < size && doc.textBetween(from, from + 1).length > 0 ? offsets(from, from + 1) : null;
  if (after) return [after[0], after[0]];
  const before =
    from > 0 && doc.textBetween(from - 1, from).length > 0 ? offsets(from - 1, from) : null;
  if (before) return [before[1], before[1]];
  return null;
}

/** The editor range for source offsets [start, end), or null. */
export function sourceToRichSelection(
  doc: PMNode,
  markdown: string,
  start: number,
  end: number
): { from: number; to: number } | null {
  const range = (a: number, b: number) => {
    const ref = linesForSourceSelection(markdown, a, b);
    return ref ? rangeForLines(doc, markdown, ref) : null;
  };
  if (end > start) return range(start, end);
  // A caret: map the character after it on its line, else the one before.
  const nextIsText = start < markdown.length && markdown[start] !== '\n';
  const after = nextIsText ? range(start, start + 1) : null;
  if (after) return { from: after.from, to: after.from };
  const prevIsText = start > 0 && markdown[start - 1] !== '\n';
  const before = prevIsText ? range(start - 1, start) : null;
  if (before) return { from: before.to, to: before.to };
  return null;
}
