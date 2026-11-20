import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeToChipMarkdown } from '@desktop/utils/nodeChip';
import { ChipNode } from './ChipNode';

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const id = `${tableId}/${entryId}`;
const href = `entry:${id}`;
const editors: Editor[] = [];

function paste(content: string, format: 'text' | 'html', parseBareIds: boolean) {
  const editor = new Editor({
    extensions: [StarterKit, ChipNode.configure({ parseBareIds })],
    content: '<p></p>',
  });
  editors.push(editor);
  // jsdom lacks ClipboardEvent. Passing the DOM event explicitly still runs
  // ProseMirror's real paste transaction and TipTap's registered paste rules.
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  if (format === 'text') editor.view.pasteText(content, event);
  else {
    const paragraph = document.createElement('p');
    paragraph.textContent = content;
    editor.view.pasteHTML(paragraph.outerHTML, event);
  }
  return editor;
}

function chips(editor: Editor) {
  const result: Record<string, unknown>[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'chip') result.push(node.attrs);
  });
  return result;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe.each(['text', 'html'] as const)('real %s entry-reference paste', (format) => {
  describe.each([false, true])('parseBareIds=%s', (parseBareIds) => {
    it.each(['A name', '', '[Draft] \\ path'])(
      'pastes the reference label %j as exactly one entry chip',
      (title) => {
        const editor = paste(
          nodeToChipMarkdown({ kind: 'entry', id, title }),
          format,
          parseBareIds
        );
        expect(chips(editor)).toEqual([
          expect.objectContaining({ kind: 'entry', href, title, include: false }),
        ]);
        expect(editor.state.doc.textContent).toBe('');
      }
    );

    it('preserves named image markdown as literal text instead of converting its inner link', () => {
      const markdown = `![Illustration](${href})`;
      const editor = paste(markdown, format, parseBareIds);
      expect(chips(editor)).toEqual([]);
      expect(editor.state.doc.textContent).toBe(markdown);
    });

    it('converts an adjacent real reference without converting the named image or its table id', () => {
      const image = `![Illustration](${href})`;
      const reference = nodeToChipMarkdown({ kind: 'entry', id, title: 'Record' });
      const editor = paste(`${image} and ${reference}`, format, parseBareIds);
      expect(chips(editor)).toEqual([
        expect.objectContaining({ kind: 'entry', href, title: 'Record', include: false }),
      ]);
      expect(editor.state.doc.textContent).toBe(`${image} and `);
    });
  });
});
