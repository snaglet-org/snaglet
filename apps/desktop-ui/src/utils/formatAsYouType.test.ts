import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { PluginKey, TextSelection } from '@tiptap/pm/state';
import { formatTableName } from '@snaglet/shared/utils';
import { createFormatTextPlugin, formatFieldValue } from './formatAsYouType';

function field(value: string, start: number, end = start): HTMLInputElement {
  const input = document.createElement('input');
  document.body.append(input);
  input.value = value;
  input.setSelectionRange(start, end);
  return input;
}

const editors: Editor[] = [];
function makeEditor(content: string) {
  const editor = new Editor({ extensions: [StarterKit], content });
  editor.registerPlugin(createFormatTextPlugin(new PluginKey('format-test'), formatTableName));
  editors.push(editor);
  return editor;
}

afterEach(() => {
  document.body.replaceChildren();
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe('formatFieldValue', () => {
  it('rewrites the value in place and keeps the caret where the user typed', () => {
    // A capital typed in the middle of `work_experience`, caret after it.
    const input = field('worKk_experience', 4);
    expect(formatFieldValue(input, formatTableName)).toBe('workk_experience');
    expect(input.value).toBe('workk_experience');
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);
  });

  it('maps the caret and a selection past a pasted whitespace run that shrinks', () => {
    const input = field('Work  \t Experience notes', 8, 18);
    expect(formatFieldValue(input, formatTableName)).toBe('work_experience_notes');
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 15]);
  });

  it('leaves text that needs nothing, and any other character, untouched', () => {
    const input = field('work-experience', 3);
    expect(formatFieldValue(input, formatTableName)).toBe('work-experience');
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
  });
});

describe('createFormatTextPlugin', () => {
  it('formats a typed capital and space in place, keeping the caret beside them', () => {
    const editor = makeEditor('<p>workexperience</p>');
    editor.commands.setTextSelection(5);
    editor.view.dispatch(editor.state.tr.insertText('X Y'));
    expect(editor.state.doc.textContent).toBe('workx_yexperience');
    expect(editor.state.selection.from).toBe(8);
  });

  it('collapses a pasted whitespace run and maps a caret inside it and a range around it', () => {
    const editor = makeEditor('<p></p>');
    const tr = editor.state.tr.insertText('Work \t Experience', 1);
    // The caret sits between the space and the tab, inside the run.
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 6)));
    expect(editor.state.doc.textContent).toBe('work_experience');
    expect(editor.state.selection.from).toBe(6);

    const range = editor.state.tr.insertText(' \t Notes', 16);
    editor.view.dispatch(range.setSelection(TextSelection.create(range.doc, 3, 24)));
    expect(editor.state.doc.textContent).toBe('work_experience_notes');
    expect([editor.state.selection.anchor, editor.state.selection.head]).toEqual([3, 22]);
  });

  it('pastes multi-line text and HTML blocks as one formatted line, caret after it', () => {
    // jsdom lacks ClipboardEvent; the view still runs its real paste pipeline.
    const paste = () => new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    const editor = makeEditor('<p>log</p>');
    editor.commands.setTextSelection(1);
    editor.view.pasteText('Work\r\n\n  Experience\t', paste());
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe('work_experience_log');
    expect(editor.state.selection.from).toBe(1 + 'work_experience_'.length);

    editor.commands.setContent('<p></p>', { emitUpdate: false });
    editor.view.pasteHTML('<p>Reading <b>List</b></p><p></p><p>2026 Notes</p>', paste());
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe('reading_list_2026_notes');
    expect(editor.state.selection.from).toBe(1 + 'reading_list_2026_notes'.length);
  });

  it('keeps marks, and undoes the typing and its formatting in one step', () => {
    const editor = makeEditor('<p><strong>Bold</strong>name</p>');
    editor.commands.setTextSelection(9);
    editor.commands.insertContent('X');
    expect(editor.state.doc.textContent).toBe('boldnamex');
    expect(editor.getHTML()).toContain('<strong>bold</strong>');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe('Boldname');
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.textContent).toBe('boldnamex');
  });

  it('leaves a loaded value, IME composition, and other characters as they are', () => {
    const editor = makeEditor('<p></p>');
    editor.commands.setContent('<p>Legacy Name</p>', { emitUpdate: false });
    expect(editor.state.doc.textContent).toBe('Legacy Name');

    editor.view.dispatch(editor.state.tr.insertText('X', 1).setMeta('composition', 1));
    expect(editor.state.doc.textContent).toBe('XLegacy Name');

    editor.commands.setContent('<p></p>', { emitUpdate: false });
    editor.view.dispatch(editor.state.tr.insertText('Café-Notes', 1));
    expect(editor.state.doc.textContent).toBe('café-notes');
  });
});
