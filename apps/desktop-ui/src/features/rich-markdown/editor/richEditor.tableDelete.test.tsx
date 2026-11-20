/**
 * Each table in an editable rich doc carries a small × at its top-right
 * corner that deletes that table (not the one the caret is in), as one undo
 * step, keyboard reachable, and nowhere in a read-only editor.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

const FRUIT = '| fruit | count |\n| --- | --- |\n| apple | 2 |';
const TOOLS = '| tool | use |\n| --- | --- |\n| spade | dig |';
const DOC = `Intro\n\n${FRUIT}\n\nMiddle\n\n${TOOLS}\n\nEnd`;

/** The visible × buttons (a read-only editor keeps them hidden). */
const deleteButtons = () =>
  screen.queryAllByRole('button', { name: 'Delete table' }).filter((button) => !button.hidden);

const tableTexts = (box: HTMLElement) =>
  Array.from(box.querySelectorAll('table')).map((table) => table.textContent);

describe('the × on a table', () => {
  it('shows one per table in an editable doc, at the table’s frame', async () => {
    const ed = await mountRichEditor(DOC);
    const buttons = deleteButtons();
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveAttribute('type', 'button');
      expect(button.closest('[contenteditable="false"]')).not.toBeNull();
      expect(button.parentElement?.querySelector('table')).not.toBeNull();
    }
    expect(within(ed.box).getAllByRole('button', { name: 'Delete table' })).toHaveLength(2);
  });

  it('is hidden in a read-only editor', async () => {
    await mountRichEditor(DOC, { disabled: true });
    expect(deleteButtons()).toHaveLength(0);
  });

  it('deletes only its own table, even with the caret in the other one, as one undo step', async () => {
    const ed = await mountRichEditor(DOC);
    // Caret in the second table; delete the first.
    ed.caretAt('spade');
    const [first] = deleteButtons();
    fireEvent.mouseDown(first!);
    fireEvent.click(first!);
    expect(tableTexts(ed.box)).toEqual(['toolusespadedig']);
    expect(ed.value()).toBe(`Intro\n\nMiddle\n\n${TOOLS}\n\nEnd`);
    // The caret moves to the block after the deleted table.
    expect(ed.editor().state.selection.$from.parent.textContent).toBe('Middle');

    ed.press('z', { mod: true });
    expect(tableTexts(ed.box)).toHaveLength(2);
    // The markdown round-trips unchanged.
    expect(ed.value()).toBe(DOC);
  });

  it('deletes two tables independently, each its own undo step', async () => {
    const ed = await mountRichEditor(DOC);
    act(() => deleteButtons()[1]!.click());
    expect(ed.value()).toBe(`Intro\n\n${FRUIT}\n\nMiddle\n\nEnd`);
    act(() => deleteButtons()[0]!.click());
    expect(ed.value()).toBe('Intro\n\nMiddle\n\nEnd');
    expect(deleteButtons()).toHaveLength(0);

    ed.press('z', { mod: true });
    expect(ed.value()).toBe(`Intro\n\n${FRUIT}\n\nMiddle\n\nEnd`);
    ed.press('z', { mod: true });
    expect(ed.value()).toBe(DOC);
  });

  it('works from the keyboard: Enter or Space on a focused × deletes its table', async () => {
    const ed = await mountRichEditor(DOC);
    const user = userEvent.setup();
    const [first, second] = deleteButtons();
    act(() => second!.focus());
    expect(second).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(ed.value()).toBe(`Intro\n\n${FRUIT}\n\nMiddle\n\nEnd`);
    // Focus goes back to the editor, at the block after the table.
    expect(ed.box).toHaveFocus();

    act(() => first!.focus());
    await user.keyboard(' ');
    expect(ed.value()).toBe('Intro\n\nMiddle\n\nEnd');
  });

  it('flags the table that holds the caret, so its × shows', async () => {
    const ed = await mountRichEditor(DOC);
    const frames = () => Array.from(ed.box.querySelectorAll('.tableFrame'));
    expect(frames()).toHaveLength(2);
    ed.caretAt('apple');
    expect(frames()[0]).toHaveAttribute('data-table-active');
    expect(frames()[1]).not.toHaveAttribute('data-table-active');
    ed.caretAt('Middle');
    expect(frames().some((frame) => frame.hasAttribute('data-table-active'))).toBe(false);
  });
});
