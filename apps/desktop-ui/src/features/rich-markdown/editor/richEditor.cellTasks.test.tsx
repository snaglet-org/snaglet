/**
 * Checkboxes in table cells. A cell line that starts with `[ ]` or `[x]` is a
 * task item, the same checkbox a doc shows anywhere else, however it got
 * there: typed with the `[ ] ` shortcut, written by an agent, or loaded from
 * a save that wrote `☐` / `☑`. It saves as `[ ]` / `[x]`, and a reload reads
 * it back the same.
 */
import { act, fireEvent } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { docToRichMarkdown, richMarkdownToDoc } from './richMarkdown';
import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

const DOC_ID = 'doc-1111111111111-9gqbtkgh1';
const table = (...cells: string[]) =>
  [
    '| Done | Task |',
    '| --- | --- |',
    ...cells.map((cell, i) => `| ${cell} | task ${i + 1} |`),
  ].join('\n');

/** Each body cell of the first column, as `block(items)` outline strings. */
function firstColumn(doc: PMNode): string[] {
  const cells: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'tableRow') return true;
    const cell = node.firstChild!;
    if (cell.type.name === 'tableHeader') return false;
    const blocks: string[] = [];
    cell.forEach((block) => {
      if (block.type.name === 'taskList') {
        const items: string[] = [];
        block.forEach((item) =>
          items.push(`${item.attrs.checked ? '[x]' : '[ ]'}${item.textContent}`)
        );
        blocks.push(`tasks(${items.join(', ')})`);
      } else {
        let text = '';
        block.descendants((inline) => {
          text += inline.isText
            ? inline.marks.some((mark) => mark.type.name === 'code')
              ? `\`${inline.text}\``
              : inline.marks.some((mark) => mark.type.name === 'link')
                ? `<${inline.text}>`
                : inline.text
            : inline.type.name === 'hardBreak'
              ? '⏎'
              : '◆';
          return true;
        });
        blocks.push(`p:${text}`);
      }
    });
    cells.push(blocks.join(' | '));
    return false;
  });
  return cells;
}

let schema: Schema;
const parse = (markdown: string) => richMarkdownToDoc(markdown, schema, { parseBareIds: true });
const serialize = (doc: PMNode) => docToRichMarkdown({ state: { doc } } as unknown as Editor);
/** Parse then serialize, as a load then a save does. */
const save = (markdown: string) => serialize(parse(markdown));

beforeAll(async () => {
  schema = (await mountRichEditor('')).editor().schema;
});

describe('task markers in table cells', () => {
  it('reads [ ] and [x] an agent wrote as task items, and saves them as written', () => {
    const markdown = `${table('[ ]', '[x]', '[ ] buy milk', '[X] call back')}\n`;
    expect(firstColumn(parse(markdown))).toEqual([
      'tasks([ ])',
      'tasks([x])',
      'tasks([ ]buy milk)',
      'tasks([x]call back)',
    ]);
    expect(save(markdown)).toBe(markdown.replace('[X]', '[x]'));
    expect(save(save(markdown))).toBe(save(markdown));
  });

  it('reads the ☐ / ☑ an older save wrote as task items, and saves [ ] / [x]', () => {
    const saved = save(`${table('☐ milk', '☑', '☑ eggs<br>☐ bread')}\n`);
    expect(saved).toBe(`${table('[ ] milk', '[x]', '[x] eggs<br>[ ] bread')}\n`);
    expect(firstColumn(parse(saved))).toEqual([
      'tasks([ ]milk)',
      'tasks([x])',
      'tasks([x]eggs, [ ]bread)',
    ]);
  });

  it('keeps the lines around task lines in a cell', () => {
    const markdown = `${table('intro<br>[ ] a<br>[x] b<br>note<br>more')}\n`;
    expect(firstColumn(parse(markdown))).toEqual(['p:intro | tasks([ ]a, [x]b) | p:note⏎more']);
    expect(save(markdown)).toBe(markdown);
  });

  it('leaves [ ] that does not open a cell line as text', () => {
    const cells = [
      'a [ ] b',
      '`[ ]` code',
      `[site](https://example.com) and [Spec](${DOC_ID})`,
      '\\[ \\] escaped',
      '[ ]**bold**',
      '**[ ]** bold',
    ];
    const doc = parse(`${table(...cells)}\n`);
    expect(firstColumn(doc)).toEqual([
      'p:a [ ] b',
      'p:`[ ]` code',
      'p:<site> and ◆',
      'p:[ ] escaped',
      'p:[ ]bold',
      'p:[ ] bold',
    ]);
    const saved = serialize(doc);
    expect(firstColumn(parse(saved))).toEqual(firstColumn(doc));
    expect(save(saved)).toBe(saved);
  });

  it('leaves task lists outside tables as they were', () => {
    const markdown = '- [ ] one\n- [x] two\n\n[ ] not a task\n';
    expect(save(markdown)).toBe('- [ ] one\n- [x] two\n\n\\[ \\] not a task');
  });

  it('reads spaces before a marker after a <br> as a task, as the read-only view does', () => {
    const markdown = `${table('a<br> [ ] b')}\n`;
    expect(firstColumn(parse(markdown))).toEqual(['p:a | tasks([ ]b)']);
    expect(save(markdown)).toBe(`${table('a<br>[ ] b')}\n`);
  });

  it('keeps a marker inside bold or a link as text, the markup in one piece', () => {
    const bold = parse(`${table('**a<br>[ ] b**')}\n`);
    expect(firstColumn(bold)).toEqual(['p:a⏎[ ] b']);
    const boldText: string[] = [];
    bold.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'bold'))
        boldText.push(node.text!);
    });
    expect(boldText).toEqual(['a', '[ ] b']);
    // Literal brackets get the escape any literal bracket in a doc gets.
    const savedBold = serialize(bold);
    expect(savedBold).toBe(`${table('**a<br>\\[ \\] b**')}\n`);
    expect(save(savedBold)).toBe(savedBold);

    const link = parse(`${table('[a<br>[ ] b](https://example.com)')}\n`);
    expect(firstColumn(link)).toEqual(['p:<a>⏎<[ ] b>']);
    const savedLink = serialize(link);
    expect(savedLink).toBe(`${table('[a<br>\\[ \\] b](https://example.com)')}\n`);
    expect(save(savedLink)).toBe(savedLink);
  });

  it('keeps a cell that starts with a private-use character as text', () => {
    const markdown = `${table('\uE000 glyph', '\uE001')}\n`;
    expect(firstColumn(parse(markdown))).toEqual(['p:\uE000 glyph', 'p:\uE001']);
    expect(save(markdown)).toBe(markdown);
  });

  it('keeps an escaped pipe inside inline code, so the row keeps its columns', () => {
    const markdown = '| A | B | C |\n| --- | --- | --- |\n| a | `x\\|y` | c |\n';
    const once = save(markdown);
    expect(once).toBe(markdown);
    expect(save(once)).toBe(markdown);
    const cells: string[] = [];
    parse(once).descendants((node) => {
      if (node.type.name === 'tableCell') cells.push(node.textContent);
      return true;
    });
    expect(cells).toEqual(['a', 'x|y', 'c']);
  });
});

describe('checkboxes in a doc table', () => {
  it('turns [ ] typed at the start of an empty cell into the task checkbox, saved as [ ]', async () => {
    const ed = await mountRichEditor(`${table('x')}\n`);
    ed.caretAt('x', 1);
    act(() => {
      ed.editor().commands.deleteRange({
        from: ed.editor().state.selection.from - 1,
        to: ed.editor().state.selection.from,
      });
    });
    ed.type('[ ] ');
    expect(firstColumn(ed.editor().state.doc)).toEqual(['tasks([ ])']);
    expect(ed.value()).toBe(`${table('[ ]')}\n`);
    ed.type('ship it');
    expect(ed.value()).toBe(`${table('[ ] ship it')}\n`);
    expect(save(ed.value())).toBe(ed.value());
  });

  it('shows every form as the same checkbox, and toggling flips [ ] and [x]', async () => {
    const ed = await mountRichEditor(`${table('[ ]', '☑ done', '[ ] todo')}\n`);
    const boxes = () =>
      Array.from(ed.box.querySelectorAll<HTMLInputElement>('td input[type="checkbox"]'));
    expect(boxes().map((box) => box.checked)).toEqual([false, true, false]);
    for (const box of boxes()) expect(box.closest('ul[data-type="taskList"] > li')).not.toBeNull();

    act(() => {
      fireEvent.click(boxes()[0]!);
    });
    expect(ed.value()).toBe(`${table('[x]', '[x] done', '[ ] todo')}\n`);
    act(() => {
      fireEvent.click(boxes()[1]!);
    });
    expect(ed.value()).toBe(`${table('[x]', '[ ] done', '[ ] todo')}\n`);
  });
});
