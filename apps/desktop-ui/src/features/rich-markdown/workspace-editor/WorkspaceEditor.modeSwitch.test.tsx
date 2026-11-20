/**
 * Switching the doc editor between the rendered and markdown views keeps
 * the user's place: the same text stays selected and focused.
 */
import type { Editor } from '@tiptap/core';
import { act, render, screen, waitFor } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { installEditorDomShims } from '../editor/richEditor.testHarness';
import { WorkspaceEditor } from './WorkspaceEditor';

beforeAll(installEditorDomShims);

const MARKDOWN = '# Notes\n\nThe first paragraph.\n\n- a list item\n- second **item**';

/** TipTap hangs the editor on its DOM node. */
function richEditor(): Editor {
  const dom = screen.getByRole('textbox', { name: 'Doc body' }) as HTMLElement & {
    editor?: Editor;
  };
  if (!dom.editor) throw new Error('no editor');
  return dom.editor;
}

function selectText(editor: Editor, text: string) {
  let from = -1;
  editor.state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text?.includes(text)) from = pos + node.text.indexOf(text);
  });
  act(() => {
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + text.length))
    );
  });
}

describe('switching between rendered and markdown views', () => {
  it('keeps the selection both ways', async () => {
    const props = { kind: 'doc-body' as const, savedValue: MARKDOWN, onSave: vi.fn() };
    const { rerender } = render(<WorkspaceEditor {...props} sourceMode={false} />);
    await waitFor(() => expect(richEditor().state.doc.textContent).toContain('second'));
    selectText(richEditor(), 'first');

    rerender(<WorkspaceEditor {...props} sourceMode />);
    const area = screen.getByTestId<HTMLTextAreaElement>('workspace-editor-source-textarea');
    expect(area).toHaveFocus();
    expect(MARKDOWN.slice(area.selectionStart, area.selectionEnd)).toBe('first');

    const start = MARKDOWN.indexOf('list');
    act(() => {
      area.setSelectionRange(start, start + 'list item'.length);
      area.dispatchEvent(new Event('select'));
    });

    rerender(<WorkspaceEditor {...props} sourceMode={false} />);
    await waitFor(() => {
      const editor = richEditor();
      const { from, to } = editor.state.selection;
      expect(editor.state.doc.textBetween(from, to)).toBe('list item');
    });
    expect(screen.getByRole('textbox', { name: 'Doc body' })).toHaveFocus();
  });

  it('keeps a caret inside formatted text', async () => {
    const props = { kind: 'doc-body' as const, savedValue: MARKDOWN, onSave: vi.fn() };
    const { rerender } = render(<WorkspaceEditor {...props} sourceMode />);
    const area = screen.getByTestId<HTMLTextAreaElement>('workspace-editor-source-textarea');
    const at = MARKDOWN.indexOf('item**') + 2;
    act(() => {
      area.focus();
      area.setSelectionRange(at, at);
      area.dispatchEvent(new Event('select'));
    });
    rerender(<WorkspaceEditor {...props} sourceMode={false} />);
    await waitFor(() => {
      const editor = richEditor();
      const { from, empty } = editor.state.selection;
      expect(empty).toBe(true);
      // The caret sat after `**it` in the source: after `it` in `item`.
      expect(editor.state.doc.textBetween(from - 6, from)).toBe('ond it');
    });
  });
});
