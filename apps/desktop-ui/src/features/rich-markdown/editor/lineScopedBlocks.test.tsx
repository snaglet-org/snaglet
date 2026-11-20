/**
 * Turning one line into a heading (or another block) must change only that
 * line. Shift+Enter, pasted `<br>`s and markdown hard breaks keep several
 * visual lines in one paragraph, and a block command must not convert the
 * whole paragraph: "/h3" on the last line leaves every line above it alone.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

// Three lines in one paragraph, as markdown hard breaks.
const THREE_LINES = 'one\\\ntwo\\\nthree';

describe('block conversions only change the selected lines', () => {
  it('"/h3" on a Shift+Enter line turns only that line into a heading', async () => {
    const ed = await mountRichEditor();
    ed.type('one');
    ed.press('Enter', { shift: true });
    ed.type('two');
    ed.press('Enter', { shift: true });
    ed.type('/h3');
    ed.press('Enter');
    ed.type('Title');

    expect(ed.outline()).toEqual(['p:one⏎two', 'h3:Title']);
    expect(ed.value()).toBe('one\\\ntwo\n\n### Title');
  });

  it.each([1, 2, 3, 4, 5, 6])(
    'Mod-Alt-%i on the middle line makes only that line a heading',
    async (level) => {
      const ed = await mountRichEditor(THREE_LINES);
      ed.caretAt('two', 1);
      ed.press(String(level), { mod: true, alt: true });
      expect(ed.outline()).toEqual(['p:one', `h${level}:two`, 'p:three']);
      expect(ed.value()).toBe(`one\n\n${'#'.repeat(level)} two\n\nthree`);
    }
  );

  it('converts the first and the last line on their own', async () => {
    const first = await mountRichEditor(THREE_LINES);
    first.caretAt('one');
    first.press('3', { mod: true, alt: true });
    expect(first.outline()).toEqual(['h3:one', 'p:two⏎three']);
    first.press('z', { mod: true });

    first.caretAt('three', 5);
    first.press('3', { mod: true, alt: true });
    expect(first.outline()).toEqual(['p:one⏎two', 'h3:three']);
  });

  it('a selection across lines turns each selected line into its own heading', async () => {
    const ed = await mountRichEditor('zero\\\none\\\ntwo\\\nthree');
    ed.select('ne', 'tw');
    ed.press('2', { mod: true, alt: true });
    expect(ed.outline()).toEqual(['p:zero', 'h2:one', 'h2:two', 'p:three']);
    // The selection stays on the same text.
    const { from, to } = ed.editor().state.selection;
    expect(ed.editor().state.doc.textBetween(from, to)).toBe('netw');
  });

  it('one undo restores the paragraph exactly', async () => {
    const ed = await mountRichEditor(THREE_LINES);
    ed.caretAt('two', 1);
    ed.press('3', { mod: true, alt: true });
    expect(ed.outline()).toEqual(['p:one', 'h3:two', 'p:three']);
    ed.press('z', { mod: true });
    expect(ed.outline()).toEqual(['p:one⏎two⏎three']);
    expect(ed.value()).toBe(THREE_LINES);
    ed.press('z', { mod: true, shift: true });
    expect(ed.outline()).toEqual(['p:one', 'h3:two', 'p:three']);
  });

  it('a code block keeps the selected lines together and leaves the rest', async () => {
    const ed = await mountRichEditor('zero\\\none\\\ntwo\\\nthree');
    ed.select('one', 'two');
    ed.press('c', { mod: true, alt: true });
    expect(ed.outline()).toEqual(['p:zero', 'code:one\ntwo', 'p:three']);
  });

  it('a quote wraps only the selected line', async () => {
    const ed = await mountRichEditor(THREE_LINES);
    ed.caretAt('three');
    ed.press('b', { mod: true, shift: true });
    expect(ed.outline()).toEqual(['p:one⏎two', 'blockquote(p:three)']);
  });

  it('turning a line into text leaves its paragraph as it is', async () => {
    const ed = await mountRichEditor(THREE_LINES);
    ed.caretAt('two');
    ed.press('0', { mod: true, alt: true });
    expect(ed.outline()).toEqual(['p:one⏎two⏎three']);
  });

  it('keeps inline marks and links on the converted line', async () => {
    const ed = await mountRichEditor('one\\\n**bold** and [link](https://x.test)\\\nthree');
    ed.caretAt('bold');
    ed.press('3', { mod: true, alt: true });
    expect(ed.value()).toBe('one\n\n### **bold** and [link](https://x.test)\n\nthree');
  });

  it('paragraphs without hard breaks convert as before', async () => {
    const ed = await mountRichEditor('one\n\ntwo\n\nthree');
    ed.caretAt('three', 2);
    ed.press('3', { mod: true, alt: true });
    expect(ed.outline()).toEqual(['p:one', 'p:two', 'h3:three']);
  });
});
