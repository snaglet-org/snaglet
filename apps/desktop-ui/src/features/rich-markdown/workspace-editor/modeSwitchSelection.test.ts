import { describe, expect, it, vi } from 'vitest';
import { getSchema } from '@tiptap/core';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

import { ChipNode } from '@desktop/features/rich-markdown/editor/ChipNode';
import { richMarkdownToDoc } from '@desktop/features/rich-markdown/editor/richMarkdown';
import { richToSourceSelection, sourceToRichSelection } from './modeSwitchSelection';

const schema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: { autolink: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
  ChipNode.configure({ showIncludeToggle: true, parseBareIds: true }),
]);

const MARKDOWN = '# Title\n\nSome **bold** words here.\n\n- one\n- two items';
const doc = richMarkdownToDoc(MARKDOWN, schema);

function docPos(text: string, offset = 0): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text) + offset;
    }
  });
  return found;
}

describe('rendered → markdown', () => {
  it('maps a selection inside formatted text to the same characters', () => {
    const from = docPos('words');
    const offsets = richToSourceSelection(doc, MARKDOWN, from, from + 'words'.length);
    expect(offsets && MARKDOWN.slice(...offsets)).toBe('words');
  });

  it('maps a caret to the same spot in its line', () => {
    const at = docPos('items', 2);
    const offsets = richToSourceSelection(doc, MARKDOWN, at, at);
    expect(offsets).toEqual([MARKDOWN.indexOf('items') + 2, MARKDOWN.indexOf('items') + 2]);
  });

  it('maps a caret at the end of a heading to the end of its line', () => {
    const at = docPos('Title', 5);
    expect(richToSourceSelection(doc, MARKDOWN, at, at)).toEqual([7, 7]);
  });
});

describe('markdown → rendered', () => {
  it('maps a source selection to the same text', () => {
    const start = MARKDOWN.indexOf('two');
    const range = sourceToRichSelection(doc, MARKDOWN, start, start + 3);
    expect(range && doc.textBetween(range.from, range.to)).toBe('two');
  });

  it('maps a caret, including one at the end of a line', () => {
    const inWord = MARKDOWN.indexOf('Some') + 2;
    expect(sourceToRichSelection(doc, MARKDOWN, inWord, inWord)).toEqual({
      from: docPos('Some', 2),
      to: docPos('Some', 2),
    });
    const lineEnd = MARKDOWN.indexOf('# Title') + '# Title'.length;
    expect(sourceToRichSelection(doc, MARKDOWN, lineEnd, lineEnd)).toEqual({
      from: docPos('Title', 5),
      to: docPos('Title', 5),
    });
  });

  it('returns null for a caret on a blank line it cannot place', () => {
    const blank = MARKDOWN.indexOf('\n\n') + 1;
    expect(sourceToRichSelection(doc, MARKDOWN, blank, blank)).toBeNull();
  });
});
