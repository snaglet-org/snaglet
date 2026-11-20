/**
 * A table in a rich doc carries an Expand button that opens it in the same
 * large, read-only view a message table opens. The button is no part of the
 * document, and nothing in the view changes the doc or moves its caret.
 */
import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { Modal } from '@desktop/components';
import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

const FRUIT = [
  '| fruit | count | note |',
  '| --- | --- | --- |',
  '| pear | 12 | [site](https://example.com) |',
  '| apple | 2 | **crisp** |',
  '| fig | 7 | soft |',
].join('\n');
const DOC = `Intro\n\n${FRUIT}\n\n\`\`\`\ncode\n\`\`\`\n\n- item\n\nEnd`;

const expandButtons = () => screen.queryAllByRole('button', { name: 'Expand table' });

/** Body cell text of one column of the dialog's table, in the order shown. */
const dialogColumn = (dialog: HTMLElement, index: number) =>
  Array.from(dialog.querySelectorAll('tbody tr')).map(
    (row) => row.querySelectorAll('td')[index]?.textContent ?? ''
  );

/** Presses a button the way a pointer does: mousedown, then click. */
function press(button: HTMLElement) {
  fireEvent.mouseDown(button);
  fireEvent.click(button);
}

describe('Expand on a doc table', () => {
  it('shows one per table, at the table’s frame, and none for other blocks', async () => {
    const ed = await mountRichEditor(`${DOC}\n\n${FRUIT}`);
    const buttons = expandButtons();
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toHaveTextContent('Expand');
      expect(button.closest('[contenteditable="false"]')).not.toBeNull();
      expect(button.closest('.tableFrame')?.querySelector('table')).not.toBeNull();
    }
    expect(ed.box.querySelector('pre')?.closest('.tableFrame')).toBeNull();
    expect(ed.box.querySelector('ul')?.closest('.tableFrame')).toBeNull();
  });

  it('is no part of the document: never in the markdown, and pressing it changes nothing', async () => {
    const ed = await mountRichEditor(DOC);
    ed.caretAt('Intro', 2);
    const before = ed.editor().state.selection.toJSON();
    act(() => press(expandButtons()[0]!));
    await screen.findByRole('dialog', { name: 'Expanded table' });
    expect(ed.value()).toBe(DOC);
    expect(ed.editor().getText()).not.toContain('Expand');
    expect(ed.editor().state.selection.toJSON()).toEqual(before);
  });

  it('opens the table’s rows with the message view’s filter, formatting and Copy', async () => {
    await mountRichEditor(DOC);
    act(() => press(expandButtons()[0]!));
    const dialog = await screen.findByRole('dialog', { name: 'Expanded table' });
    expect(dialogColumn(dialog, 0)).toEqual(['pear', 'apple', 'fig']);
    expect(within(dialog).getByRole('link', { name: 'site' })).toHaveAttribute(
      'href',
      'https://example.com'
    );
    expect(within(dialog).getByText('crisp').tagName).toBe('STRONG');
    expect(within(dialog).getByRole('button', { name: 'Copy table' })).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toHaveTextContent('3 rows');

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Filter rows' }), {
      target: { value: 'FI' },
    });
    expect(dialogColumn(dialog, 0)).toEqual(['fig']);
  });

  it('sorts in the dialog only: the doc’s rows and markdown stay as they were', async () => {
    const ed = await mountRichEditor(DOC);
    ed.caretAt('apple', 1);
    const caret = ed.editor().state.selection.toJSON();
    act(() => press(expandButtons()[0]!));
    const dialog = await screen.findByRole('dialog', { name: 'Expanded table' });

    fireEvent.click(within(dialog).getByRole('columnheader', { name: /count/ }));
    expect(dialogColumn(dialog, 1)).toEqual(['2', '7', '12']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const docRows = Array.from(ed.box.querySelectorAll('tr')).map(
      (row) => row.querySelector('td, th')?.textContent
    );
    expect(docRows).toEqual(['fruit', 'pear', 'apple', 'fig']);
    expect(ed.value()).toBe(DOC);
    // The caret is back where it was, in a focused editor.
    expect(ed.editor().state.selection.toJSON()).toEqual(caret);
    expect(ed.box).toHaveFocus();
  });

  it('shows the table as it was at the press', async () => {
    const ed = await mountRichEditor(DOC);
    ed.caretAt('fig', 3);
    ed.type(' tree');
    act(() => press(expandButtons()[0]!));
    const dialog = await screen.findByRole('dialog', { name: 'Expanded table' });
    expect(dialogColumn(dialog, 0)).toEqual(['pear', 'apple', 'fig tree']);
  });

  it('works in a read-only editor too', async () => {
    await mountRichEditor(DOC, { disabled: true });
    act(() => press(expandButtons()[0]!));
    const dialog = await screen.findByRole('dialog', { name: 'Expanded table' });
    expect(dialogColumn(dialog, 0)).toEqual(['pear', 'apple', 'fig']);
  });

  it('closes only itself on Escape when the doc sits in another dialog', async () => {
    const user = userEvent.setup();
    const onPreviewClose = vi.fn();
    const Preview = ({ children }: { children: ReactNode }) => (
      <Modal onClose={onPreviewClose} aria-label="Doc preview">
        {children}
      </Modal>
    );
    const ed = await mountRichEditor(DOC, { wrapper: Preview });
    act(() => press(expandButtons()[0]!));
    await screen.findByRole('dialog', { name: 'Expanded table' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Filter rows' })).toHaveFocus());

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Expanded table' })).toBeNull();
    expect(onPreviewClose).not.toHaveBeenCalled();
    expect(ed.value()).toBe(DOC);

    // The next Escape belongs to the preview.
    await user.keyboard('{Escape}');
    expect(onPreviewClose).toHaveBeenCalledTimes(1);
  });

  it('keeps paste, drop and keys in the dialog away from a composer around the editor', async () => {
    const user = userEvent.setup();
    // The message composer's shell: it attaches pasted images and dropped
    // files, and has keys of its own.
    const host = { paste: vi.fn(), drop: vi.fn(), dragOver: vi.fn(), keyDown: vi.fn() };
    const Composer = ({ children }: { children: ReactNode }) => (
      <div
        onPaste={host.paste}
        onDrop={host.drop}
        onDragOver={host.dragOver}
        onKeyDown={host.keyDown}
      >
        {children}
      </div>
    );
    const pageDrop = vi.fn();
    window.addEventListener('drop', pageDrop);
    await mountRichEditor(DOC, { wrapper: Composer });
    act(() => press(expandButtons()[0]!));
    const filter = await screen.findByRole('textbox', { name: 'Filter rows' });
    await waitFor(() => expect(filter).toHaveFocus());

    fireEvent.paste(filter, { clipboardData: { files: [], getData: () => '' } });
    fireEvent.dragOver(filter);
    fireEvent.drop(filter, { dataTransfer: { files: [], types: ['Files'] } });
    await user.keyboard('fig');
    for (const handler of Object.values(host)) expect(handler).not.toHaveBeenCalled();
    // The page itself still sees the drop, and Escape still closes the dialog.
    expect(pageDrop).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Expanded table' })).toBeNull();
    window.removeEventListener('drop', pageDrop);

    // Outside the dialog the composer gets its events as before.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note' }), { key: 'a' });
    expect(host.keyDown).toHaveBeenCalledTimes(1);
    // ProseMirror checks its selection 20 ms after the editor regains focus.
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
  });
});
