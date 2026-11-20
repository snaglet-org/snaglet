import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';

import {
  applyMentionDismissLatch,
  createMentionDismissLatch,
  latchMentionDismissal,
  mapPosAcrossReplace,
  type MentionState,
} from './chipEditableInput.helpers';

/**
 * Fabricate a mention state for a `@`-token whose `@` sits at doc position
 * `atPos`. The latch keys off `range.from`, which stays fixed while the user
 * types after the `@` (typing extends `range.to`).
 */
function mentionAt(atPos: number, query = ''): MentionState {
  return {
    query,
    range: { from: atPos, to: atPos + query.length + 1 },
    anchor: { left: 0, top: 0, bottom: 0, width: 1 },
  };
}

describe('mention dismissal latch', () => {
  it('starts unlatched and passes active mentions through untouched', () => {
    const latch = createMentionDismissLatch();
    expect(latch.dismissedAt).toBeNull();

    const state = mentionAt(3, 'foo');
    expect(applyMentionDismissLatch(latch, state)).toBe(state);
    expect(latch.dismissedAt).toBeNull();

    // No active token → nothing to show, latch stays clear.
    expect(applyMentionDismissLatch(latch, null)).toBeNull();
    expect(latch.dismissedAt).toBeNull();
  });

  it('escape → continued typing in the same @-token stays closed', () => {
    const latch = createMentionDismissLatch();

    // User has `@foo` open at doc position 3.
    const opened = mentionAt(3, 'foo');
    expect(applyMentionDismissLatch(latch, opened)).toBe(opened);

    // Escape dismisses the popover: latch the current token.
    latchMentionDismissal(latch, opened);
    expect(latch.dismissedAt).toBe(3);

    // The next keystroke re-derives the same active token (`@foobar…`) at the
    // same `@` position, so it stays suppressed.
    expect(applyMentionDismissLatch(latch, mentionAt(3, 'foob'))).toBeNull();
    expect(applyMentionDismissLatch(latch, mentionAt(3, 'foobar'))).toBeNull();
    // Latch is retained across those keystrokes.
    expect(latch.dismissedAt).toBe(3);
  });

  it('deleting the @-token clears the latch', () => {
    const latch = createMentionDismissLatch();
    latchMentionDismissal(latch, mentionAt(3, 'foo'));
    expect(latch.dismissedAt).toBe(3);

    // Deleting back past the `@` removes the active token → null state.
    expect(applyMentionDismissLatch(latch, null)).toBeNull();
    expect(latch.dismissedAt).toBeNull();

    // A `@` retyped afterward, even at the same position, reopens.
    const reopened = mentionAt(3, 'b');
    expect(applyMentionDismissLatch(latch, reopened)).toBe(reopened);
    expect(latch.dismissedAt).toBeNull();
  });

  it('a fresh @ at a NEW position reopens the search and clears the latch', () => {
    const latch = createMentionDismissLatch();

    // Dismiss `@foo` at position 3…
    latchMentionDismissal(latch, mentionAt(3, 'foo'));
    expect(latch.dismissedAt).toBe(3);

    // …then a second `@` becomes the active token at position 9 (`@foo bar @`).
    const fresh = mentionAt(9, '');
    expect(applyMentionDismissLatch(latch, fresh)).toBe(fresh);
    // The earlier dismissal is cleared.
    expect(latch.dismissedAt).toBeNull();
  });

  it('latchMentionDismissal(null) clears an armed latch', () => {
    const latch = createMentionDismissLatch();
    latchMentionDismissal(latch, mentionAt(3, 'foo'));
    expect(latch.dismissedAt).toBe(3);

    latchMentionDismissal(latch, null);
    expect(latch.dismissedAt).toBeNull();
  });

  it('full lifecycle: escape → stays closed → delete clears → new @ reopens', () => {
    const latch = createMentionDismissLatch();

    // Open + escape.
    const opened = mentionAt(2, 'cl');
    expect(applyMentionDismissLatch(latch, opened)).toBe(opened);
    latchMentionDismissal(latch, opened);

    // Typing stays closed.
    expect(applyMentionDismissLatch(latch, mentionAt(2, 'cli'))).toBeNull();
    expect(applyMentionDismissLatch(latch, mentionAt(2, 'clio'))).toBeNull();

    // Delete the token → latch clears.
    expect(applyMentionDismissLatch(latch, null)).toBeNull();

    // New `@` reopens.
    const next = mentionAt(2, 'd');
    expect(applyMentionDismissLatch(latch, next)).toBe(next);
  });
});

describe('mapPosAcrossReplace', () => {
  const schema = new Schema({
    nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
  });
  const doc = (...paragraphs: string[]) =>
    schema.node(
      'doc',
      null,
      paragraphs.map((text) => schema.node('paragraph', null, text ? schema.text(text) : []))
    );
  // Position just after `offset` characters of the first paragraph.
  const at = (offset: number) => 1 + offset;

  it('keeps a caret before the change and shifts one after it', () => {
    const before = doc('abcdef');
    const after = doc('abcXYdef');
    expect(mapPosAcrossReplace(before, after, at(2))).toBe(at(2));
    expect(mapPosAcrossReplace(before, after, at(4))).toBe(at(6));
  });

  it('moves a caret inside the replaced span to its end', () => {
    expect(mapPosAcrossReplace(doc('abcdef'), doc('aZf'), at(3))).toBe(at(2));
  });

  it('follows a whole paragraph added above', () => {
    const before = doc('second');
    const after = doc('first', 'second');
    // "first" adds its 5 characters plus a paragraph's 2 boundary tokens.
    expect(mapPosAcrossReplace(before, after, at(3))).toBe(at(3) + 7);
  });

  it('handles a change inside a repeated run', () => {
    expect(mapPosAcrossReplace(doc('aa'), doc('aaa'), at(2))).toBe(at(2));
    expect(mapPosAcrossReplace(doc('aaa'), doc('aa'), at(3))).toBe(at(2));
  });

  it('leaves the position alone when nothing changed', () => {
    expect(mapPosAcrossReplace(doc('same'), doc('same'), at(2))).toBe(at(2));
  });
});
