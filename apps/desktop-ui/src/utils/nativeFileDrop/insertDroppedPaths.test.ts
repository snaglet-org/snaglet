import { describe, expect, it, vi } from 'vitest';

// insertDroppedPaths → richMarkdown → agentMentionCache pulls in the
// `@desktop/utils/api` barrel, whose config module throws at import time
// without a runtime env. Stub the vars before the import graph evaluates
// (canonical pattern used by the other api-touching suites — see
// sourceMarkdownRoundTrip.test.ts).
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { insertDroppedPathsAtPos } from './insertDroppedPaths';

function createEditor(html: string): Editor {
  // A minimal StarterKit editor is enough to exercise insertDroppedPathsAtPos
  // — it only ever touches paragraph + text nodes, the same vocabulary
  // ChipEditableInput's schema always includes regardless of richBlocks.
  return new Editor({ extensions: [StarterKit], content: html });
}

describe('insertDroppedPathsAtPos', () => {
  it('inserts a single dropped path as plain text at the given position', () => {
    const editor = createEditor('<p>Notes:</p>');
    const pos = editor.state.doc.content.size - 1; // end of the paragraph's text
    insertDroppedPathsAtPos(editor, '/Users/user/Desktop/todo.txt', pos);

    expect(editor.getText()).toBe('Notes:/Users/user/Desktop/todo.txt');
    editor.destroy();
  });

  it('splits multiple newline-joined paths into separate paragraphs, correctly merging with the surrounding text mid-paragraph', () => {
    const editor = createEditor('<p>beforeafter</p>');
    const pos = 1 + 'before'.length; // caret between "before" and "after"

    insertDroppedPathsAtPos(editor, '/a/one.txt\n/a/two.txt', pos);

    const paragraphs: string[] = [];
    editor.state.doc.forEach((node) => paragraphs.push(node.textContent));
    expect(paragraphs).toEqual(['before/a/one.txt', '/a/two.txtafter']);
    editor.destroy();
  });

  it('does not insert anything for an empty paths string', () => {
    const editor = createEditor('<p>hello</p>');
    insertDroppedPathsAtPos(editor, '', 1);
    expect(editor.getText()).toBe('hello');
    editor.destroy();
  });

  it('clamps an out-of-range position instead of throwing', () => {
    const editor = createEditor('<p>hi</p>');
    expect(() => insertDroppedPathsAtPos(editor, '/a', 9999)).not.toThrow();
    expect(editor.getText()).toBe('hi/a');
    editor.destroy();
  });

  it('is a no-op once the editor has been destroyed', () => {
    const editor = createEditor('<p>hi</p>');
    editor.destroy();
    expect(() => insertDroppedPathsAtPos(editor, '/a', 1)).not.toThrow();
  });
});
