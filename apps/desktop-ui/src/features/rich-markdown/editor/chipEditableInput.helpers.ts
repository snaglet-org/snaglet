import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Selection } from '@tiptap/pm/state';

import type { NodeMentionAnchor } from './NodeMentionSearch';
import type { SlashMenuAnchor } from './SlashMenu';

export interface MentionState {
  query: string;
  range: { from: number; to: number };
  anchor: NodeMentionAnchor;
}

const MENTION_BOUNDARY_RE = /[\s([{]/;

// Matches an in-progress `@...` mention at the caret.
// The mention body may contain spaces so users can type natural multi-word
// queries like `@project search` before picking a node / file / folder.
// The leading boundary group enforces that `@` starts a word (BOL or
// preceded by whitespace / opening bracket), so `foo@bar` doesn't match.
export const TYPED_MENTION_AT_CARET_RE = /(?:^|[\s([{])@([^@\n]{0,120})$/;

const TYPED_FILE_PATH_AT_CARET_RE = /(?:^|[\s([{`])([^\s()[\]{}<>`"']{1,240})\s$/;

/**
 * The text typed since the last chip, as a search (`mentionOnType` pickers):
 * no `@` needed, though a leading one is allowed. Blank text opens nothing.
 */
function typedSearchAtSelection(textBefore: string): { query: string; length: number } | null {
  const segment = textBefore.slice(textBefore.lastIndexOf('\n') + 1);
  const typed = segment.trimStart();
  if (!typed.trim() || typed.length > 121) return null;
  const query = typed.startsWith('@') ? typed.slice(1) : typed;
  return { query, length: typed.length };
}

export function activeMentionAtSelection(
  editor: Editor,
  options: { onType?: boolean } = {}
): MentionState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { from, $from } = selection;
  if ($from.parent.type.name !== 'paragraph') return null;

  // Chips are leaves: they read as '\n' here, so a query never spans one.
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
  let query: string;
  let tokenLength: number;
  if (options.onType) {
    const typed = typedSearchAtSelection(textBefore);
    if (!typed) return null;
    query = typed.query;
    tokenLength = typed.length;
  } else {
    const atIndex = textBefore.lastIndexOf('@');
    if (atIndex < 0) return null;

    const beforeAt = atIndex > 0 ? textBefore[atIndex - 1] : '';
    if (beforeAt && !MENTION_BOUNDARY_RE.test(beforeAt)) return null;

    query = textBefore.slice(atIndex + 1);
    if (query.includes('\n') || query.length > 120) return null;
    // A space straight after `@` is prose (`a @ b`), not a mention.
    if (/^\s/.test(query)) return null;
    // Allow spaces inside the in-progress mention query so users can type
    // natural multi-word searches like `@project search` or filtered queries
    // like `@file:palette search`. The mention stays active until newline,
    // another `@`, or the max length limit.
    tokenLength = query.length + 1;
  }

  const editorRect = editor.view.dom.getBoundingClientRect();
  let caretRect: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'> = editorRect;
  try {
    const coords = editor.view.coordsAtPos(from);
    caretRect = {
      left: coords.left,
      top: coords.top,
      bottom: coords.bottom,
      width: Math.max(1, coords.right - coords.left),
    };
  } catch {
    // Fallback to the editor box if ProseMirror cannot resolve caret coords.
  }
  return {
    query,
    range: { from: from - tokenLength, to: from },
    anchor: {
      left: caretRect.left,
      top: caretRect.top,
      bottom: caretRect.bottom,
      width: caretRect.width,
    },
  };
}

/**
 * Dismissal latch for the `@`-mention popover.
 *
 * The mention state is *re-derived from the text* on every keystroke (a
 * greedy `@...` token stays "active" until newline / another `@` / the length
 * cap). That means an Escape that only clears `mentionState` gets undone by
 * the very next keystroke, which re-derives the same active token and reopens
 * the popover. The latch remembers the doc position of the `@` the user
 * dismissed so that specific token stays closed — while a genuinely new `@`
 * (at a different position) still opens a fresh search.
 *
 * `dismissedAt` is the ProseMirror doc position of the dismissed `@`
 * (`MentionState.range.from`), or null when nothing is latched.
 */
export interface MentionDismissLatch {
  dismissedAt: number | null;
}

/** What a latch keys on: the doc position where the dismissed token starts.
 *  The slash menu reuses the latch for its `/` tokens. */
interface LatchableState {
  range: { from: number };
}

export function createMentionDismissLatch(): MentionDismissLatch {
  return { dismissedAt: null };
}

/**
 * Arm the latch for the `@`-token of the currently-open mention. Called when
 * the user explicitly dismisses the popover (Escape / click-away). Passing a
 * null state clears the latch (nothing to suppress).
 */
export function latchMentionDismissal(
  latch: MentionDismissLatch,
  state: LatchableState | null
): void {
  latch.dismissedAt = state ? state.range.from : null;
}

/**
 * Apply the dismissal latch to a freshly-derived mention state, returning the
 * state to actually show (or null to keep the popover closed) and updating the
 * latch in place:
 *
 *  - no active `@`-token     → clear the latch (token deleted / caret left);
 *                              a later `@` reopens normally.
 *  - active `@` at latched pos → suppressed: return null, keep the latch
 *                              (subsequent keystrokes in the same token stay
 *                              closed).
 *  - active `@` at a new pos  → a fresh `@` token: clear the latch and return
 *                              the state so the search reopens.
 */
export function applyMentionDismissLatch<S extends LatchableState>(
  latch: MentionDismissLatch,
  state: S | null
): S | null {
  if (!state) {
    latch.dismissedAt = null;
    return null;
  }
  if (latch.dismissedAt === state.range.from) {
    return null;
  }
  latch.dismissedAt = null;
  return state;
}

export function filePathCandidateAtSelection(
  editor: Editor
): { path: string; from: number; to: number } | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { from, $from } = selection;
  if ($from.parent.type.name !== 'paragraph') return null;

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
  const match = TYPED_FILE_PATH_AT_CARET_RE.exec(textBefore);
  if (!match) return null;

  const path = match[1];
  if (!path.includes('/') && !path.includes('.')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const to = from - 1; // keep the trailing whitespace the user typed
  return { path, from: to - path.length, to };
}

export interface SlashState {
  query: string;
  range: { from: number; to: number };
  anchor: SlashMenuAnchor;
}

// `/command` at the caret: the slash must start the block or follow
// whitespace, and the query is a short bare word (any whitespace closes
// the menu so prose containing `/` doesn't trap the keyboard).
const SLASH_AT_CARET_RE = /(?:^|\s)\/([a-zA-Z0-9]{0,24})$/;

export function activeSlashAtSelection(editor: Editor): SlashState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { from, $from } = selection;
  if ($from.parent.type.name !== 'paragraph') return null;

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
  const match = SLASH_AT_CARET_RE.exec(textBefore);
  if (!match) return null;

  const query = match[1];
  const slashStart = from - query.length - 1;
  const coords = editor.view.coordsAtPos(slashStart);
  return {
    query,
    range: { from: slashStart, to: from },
    anchor: {
      left: coords.left,
      top: coords.top,
      bottom: coords.bottom,
      width: coords.right - coords.left,
    },
  };
}

/**
 * Where `pos` in `before` lands in `after` when `after` replaced the whole
 * document. Text outside the changed span keeps its place, so the caret stays
 * on the characters it was next to; a caret inside the span goes to its end.
 */
export function mapPosAcrossReplace(before: PMNode, after: PMNode, pos: number): number {
  const start = before.content.findDiffStart(after.content);
  if (start === null) return pos;
  const end = before.content.findDiffEnd(after.content);
  if (!end) return pos;
  // The unchanged prefix and suffix can overlap ("aa" -> "aaa"); the
  // changed span starts no earlier than the prefix ends.
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  const endBefore = end.a + overlap;
  const endAfter = end.b + overlap;
  if (pos <= start) return pos;
  if (pos >= endBefore) return Math.min(pos + endAfter - endBefore, after.content.size);
  return endAfter;
}

/** `selection` from `before`, carried onto the replacing document `after`. */
export function selectionAcrossReplace(
  before: PMNode,
  after: PMNode,
  selection: { from: number; to: number }
): Selection {
  const from = mapPosAcrossReplace(before, after, selection.from);
  const to = mapPosAcrossReplace(before, after, selection.to);
  return TextSelection.between(after.resolve(from), after.resolve(Math.max(from, to)));
}
