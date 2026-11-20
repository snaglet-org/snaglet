import { afterEach, describe, expect, it } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  createDocumentFindPlugin,
  documentFindKey,
  findDocumentText,
  replaceDocumentMatches,
} from './documentFindPlugin';
import { findText } from './findText';

const editors: Editor[] = [];
function makeEditor(content: string) {
  const chip = Node.create({
    name: 'chip',
    group: 'inline',
    inline: true,
    atom: true,
    parseHTML: () => [{ tag: 'span[data-chip]' }],
    renderHTML: () => ['span', { 'data-chip': 'true' }, 'Chip target'],
  });
  const editor = new Editor({ extensions: [StarterKit, chip], content });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe('document find', () => {
  it('finds literal text across marks, preserving regex punctuation and original Unicode offsets', () => {
    const editor = makeEditor('<p>Find <strong>the</strong> target. THE target.</p>');
    expect(findDocumentText(editor.state.doc, 'the target', false)).toEqual([
      { from: 6, to: 16 },
      { from: 18, to: 28 },
    ]);
    expect(findDocumentText(editor.state.doc, 'the target', true)).toHaveLength(1);
    expect(findText('İ [] a.* aZZ', '[]')).toEqual([{ from: 2, to: 4 }]);
    expect(findText('a.* aZZ', 'a.*')).toEqual([{ from: 0, to: 3 }]);
  });
  it('does not search or replace atom content, chip boundaries, or block boundaries', () => {
    const editor = makeEditor('<p>left<span data-chip="true"></span>right</p><p>next</p>');
    for (const query of ['Chip target', 'leftright', 'rightnext'])
      expect(findDocumentText(editor.state.doc, query, false)).toEqual([]);
    const before = editor.getJSON();
    replaceDocumentMatches(editor, findDocumentText(editor.state.doc, 'right', false), 'updated');
    expect(editor.getHTML()).toContain('data-chip="true"');
    expect(editor.getHTML()).toContain('updated');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });
  it('replaces all matches in one undo event and keeps adjacent editing separate', () => {
    const editor = makeEditor('<h2>target</h2><p><strong>target</strong> target</p>');
    const before = editor.getJSON();
    replaceDocumentMatches(editor, findDocumentText(editor.state.doc, 'target', false), '$&');
    expect(editor.state.doc.textContent).toBe('$&$& $&');
    expect(editor.getHTML()).toContain('<strong>$&amp;</strong>');
    editor.commands.insertContent('typed');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe('$&$& $&');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });
  it('decorates matches without changing the document or dirtying the editor', () => {
    const editor = makeEditor('<p>target TARGET</p>');
    const before = editor.state.doc;
    editor.registerPlugin(createDocumentFindPlugin());
    editor.view.dispatch(
      editor.state.tr.setMeta(documentFindKey, { query: 'target', caseSensitive: false, index: 1 })
    );
    expect(editor.view.dom.querySelectorAll('.snaglet-find-match')).toHaveLength(2);
    expect(editor.view.dom.querySelector('.snaglet-find-current')?.textContent).toBe('TARGET');
    expect(editor.state.doc).toBe(before);
    expect(editor.commands.undo()).toBe(false);
  });
});
