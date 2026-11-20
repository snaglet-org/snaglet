import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { handlerEditorTheme } from './handlerEditorTheme';

describe('handlerEditorTheme', () => {
  it('produces a usable CodeMirror extension (accepted by EditorState.create)', () => {
    // The real regression this guards: a malformed extension (bad tag,
    // wrong shape) throws at EditorState.create time, not at import time —
    // asserting the theme composes into a working state is a cheap way to
    // catch that without mounting a full EditorView/DOM.
    expect(() =>
      EditorState.create({ doc: 'const x = 1;', extensions: [handlerEditorTheme()] })
    ).not.toThrow();
  });

  it('returns a non-empty extension list', () => {
    const ext = handlerEditorTheme();
    expect(Array.isArray(ext)).toBe(true);
    expect((ext as unknown[]).length).toBeGreaterThan(0);
  });
});
