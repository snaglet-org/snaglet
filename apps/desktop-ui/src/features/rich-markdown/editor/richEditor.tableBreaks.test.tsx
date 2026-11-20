/**
 * Line breaks inside a table cell. A GFM cell is one source line, so a break
 * is written `<br>`. The rich editor loads `<br>` as a real line break, keeps
 * it through edits, and saves every line of a cell (Shift+Enter, Enter, a
 * list typed into the cell) as `<br>`. Before, `<br>` loaded as literal
 * text, extra lines saved joined by a space or run together, and a
 * Shift+Enter break wrote a newline that split the table row.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { docToRichMarkdown, richMarkdownToDoc } from './richMarkdown';
import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

const DOC_ID = 'doc-1111111111111-9gqbtkgh1';
const table = (cell: string, header = 'Why') =>
  `| Case | ${header} |\n| --- | --- |\n| A | ${cell} |\n| B | plain |`;
const REASONS = '• first reason<br>• second reason<br>• third reason';

/** The cell holding `text`, as an outline string (`⏎` = hard break). */
function cellOf(ed: Awaited<ReturnType<typeof mountRichEditor>>, text: string): string {
  let found = '';
  ed.editor().state.doc.descendants((node) => {
    if (found || (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader')) return true;
    if (!node.textContent.includes(text)) return false;
    const blocks: string[] = [];
    node.forEach((block) => {
      let line = '';
      block.descendants((inline) => {
        if (inline.isText) line += inline.text;
        else if (inline.type.name === 'hardBreak') line += '⏎';
        else if (inline.type.name === 'chip') line += '◆';
        return true;
      });
      blocks.push(`${block.type.name}:${line}`);
    });
    found = blocks.join(' | ');
    return false;
  });
  return found;
}

/** Parse and serialize again, as a reload then a save does. */
function reload(editor: Editor, markdown: string): string {
  const doc: PMNode = richMarkdownToDoc(markdown, editor.schema, { parseBareIds: true });
  return docToRichMarkdown({ state: { doc } } as unknown as Editor);
}

describe('table cells with <br>', () => {
  it('loads <br> in a cell as line breaks, not text', async () => {
    const ed = await mountRichEditor(table(REASONS));
    expect(cellOf(ed, 'first')).toBe('paragraph:• first reason⏎• second reason⏎• third reason');
  });

  it.each(['<br/>', '<br />', '<BR>'])('reads %s the same way and saves it as <br>', async (br) => {
    const ed = await mountRichEditor(table(`one${br}two`));
    expect(cellOf(ed, 'one')).toBe('paragraph:one⏎two');
    ed.caretAt('plain', 5);
    ed.type('!');
    expect(ed.value()).toBe(`${table('one<br>two').replace('plain', 'plain!')}\n`);
  });

  it('keeps every <br> when another part of the cell is edited', async () => {
    const ed = await mountRichEditor(table(REASONS));
    ed.caretAt('second reason', 6);
    ed.type(' and more');
    expect(ed.value()).toBe(
      `${table('• first reason<br>• second and more reason<br>• third reason')}\n`
    );
  });

  it('loads breaks in a header cell too', async () => {
    const ed = await mountRichEditor(table('x', 'Why<br>(short)'));
    expect(cellOf(ed, 'Why')).toBe('paragraph:Why⏎(short)');
    ed.caretAt('x', 1);
    ed.type('y');
    expect(ed.value()).toBe(`${table('xy', 'Why<br>(short)')}\n`);
  });

  it('saves Shift+Enter in a cell as <br> and keeps the row whole', async () => {
    const ed = await mountRichEditor(table('first'));
    ed.caretAt('first', 5);
    ed.press('Enter', { shift: true });
    ed.type('second');
    const saved = `${table('first<br>second')}\n`;
    expect(ed.value()).toBe(saved);
    expect(reload(ed.editor(), saved)).toBe(saved);
  });

  it('saves Enter in a cell (a new paragraph) as <br>, and it reloads the same', async () => {
    const ed = await mountRichEditor(table('first'));
    ed.caretAt('first', 5);
    ed.press('Enter');
    ed.type('second');
    expect(cellOf(ed, 'second')).toBe('paragraph:first | paragraph:second');
    const saved = `${table('first<br>second')}\n`;
    expect(ed.value()).toBe(saved);
    expect(reload(ed.editor(), saved)).toBe(saved);
  });

  it('saves a list typed into a cell line by line, never run together', async () => {
    const ed = await mountRichEditor(table('intro'));
    ed.caretAt('intro', 5);
    ed.press('Enter');
    ed.type('- handing the next step to a peer');
    ed.press('Enter');
    ed.type('steering a running peer');
    const saved = ed.value();
    expect(saved).toBe(
      `${table('intro<br>• handing the next step to a peer<br>• steering a running peer')}\n`
    );
    expect(reload(ed.editor(), saved)).toBe(saved);
  });

  it('keeps marks, links, chips and a trailing break in a cell', async () => {
    const cell = `**bold**<br>[site](https://example.com)<br>see [Spec](${DOC_ID})<br>`;
    const ed = await mountRichEditor(table(cell));
    expect(cellOf(ed, 'bold')).toBe('paragraph:bold⏎site⏎see ◆⏎');
    ed.caretAt('plain', 0);
    ed.type('a ');
    expect(ed.value()).toBe(`${table(cell).replace('plain', 'a plain')}\n`);
  });

  it('keeps <br> inside inline code as text, and pipes stay escaped', async () => {
    const cell = '`a<br>b` and x \\| y';
    const ed = await mountRichEditor(table(cell));
    expect(cellOf(ed, 'and')).toBe('paragraph:a<br>b and x | y');
    ed.caretAt('plain', 5);
    ed.type('!');
    expect(ed.value()).toBe(`${table(cell).replace('plain', 'plain!')}\n`);
  });

  it('saves a cell the old serializer already flattened exactly as it is', async () => {
    const damaged = table(
      'someone who is already here You are handing the next step to a peerYou are steering'
    );
    const ed = await mountRichEditor(damaged);
    ed.caretAt('plain', 5);
    ed.type('!');
    expect(ed.value()).toBe(`${damaged.replace('plain', 'plain!')}\n`);
  });

  it('leaves <br> outside a table as text', async () => {
    const ed = await mountRichEditor('one<br>two');
    expect(ed.outline()).toEqual(['p:one<br>two']);
  });

  it('pastes a table with <br> cells as line breaks', async () => {
    const ed = await mountRichEditor('');
    ed.paste(table(REASONS));
    expect(cellOf(ed, 'first')).toBe('paragraph:• first reason⏎• second reason⏎• third reason');
  });
});
