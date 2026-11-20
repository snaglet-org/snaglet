/**
 * The caret across an external `value` change (a save from another client).
 *
 * Hosts that opt in keep the caret on the text it was next to, even when the
 * other client's edit landed before it; without the opt-in the caret moves to
 * the end, which hosts that append to `value` rely on.
 */
import { useState } from 'react';
import type { Editor } from '@tiptap/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { ChipEditableInput } from './ChipEditableInput';

let editor: Editor | null = null;
let setExternal: (value: string) => void = () => undefined;

function Host({ initial, keep }: { initial: string; keep: boolean }) {
  const [value, setValue] = useState(initial);
  setExternal = setValue;
  return (
    <ChipEditableInput
      value={value}
      onChange={setValue}
      onEditorReady={(next) => {
        editor = next;
      }}
      richBlocks
      multiline
      ariaLabel="Note"
      enableNodeMentions={false}
      keepSelectionOnExternalChange={keep}
    />
  );
}

async function mount(initial: string, keep: boolean) {
  editor = null;
  render(<Host initial={initial} keep={keep} />);
  const box = await screen.findByRole('textbox', { name: 'Note' });
  // Paragraphs render without the blank line between them.
  await waitFor(() => expect(box).toHaveTextContent(initial.split('\n')[0]));
  const ed = editor as unknown as Editor;
  return { box, ed };
}

/** The text on each side of the caret, within its paragraph. */
function aroundCaret(ed: Editor): [string, string] {
  const { $from } = ed.state.selection;
  return [
    $from.parent.textBetween(0, $from.parentOffset),
    $from.parent.textBetween($from.parentOffset, $from.parent.content.size),
  ];
}

describe('ChipEditableInput caret across an external change', () => {
  // jsdom has no layout; focus and selection scrolling need these to exist.
  beforeAll(() => {
    if (!document.elementFromPoint) document.elementFromPoint = () => null;
    if (!Range.prototype.getClientRects)
      Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    if (!Range.prototype.getBoundingClientRect)
      Range.prototype.getBoundingClientRect = () => new DOMRect();
  });

  function placeCaretAfter(ed: Editor, text: string) {
    act(() => {
      ed.view.focus();
      let target = -1;
      ed.state.doc.descendants((node, pos) => {
        if (target < 0 && node.isText && node.text?.includes(text))
          target = pos + node.text.indexOf(text) + text.length;
      });
      ed.commands.setTextSelection(target);
    });
    expect(ed.isFocused).toBe(true);
  }

  it('keeps the caret on the same text when the change lands before it', async () => {
    const { box, ed } = await mount('First line\n\nSecond line here', true);
    placeCaretAfter(ed, 'Second');

    act(() => setExternal('An added line\n\nFirst line\n\nSecond line here'));
    await waitFor(() => expect(box).toHaveTextContent('An added line'));
    expect(aroundCaret(ed)).toEqual(['Second', ' line here']);
  });

  it('keeps the caret when the change lands after it', async () => {
    const { box, ed } = await mount('Alpha beta', true);
    placeCaretAfter(ed, 'Alpha');

    act(() => setExternal('Alpha beta gamma'));
    await waitFor(() => expect(box).toHaveTextContent('Alpha beta gamma'));
    expect(aroundCaret(ed)).toEqual(['Alpha', ' beta gamma']);
  });

  it('moves the caret to the end without the opt-in', async () => {
    const { box, ed } = await mount('Alpha beta', false);
    placeCaretAfter(ed, 'Alpha');

    act(() => setExternal('Alpha beta gamma'));
    await waitFor(() => expect(box).toHaveTextContent('Alpha beta gamma'));
    expect(aroundCaret(ed)).toEqual(['Alpha beta gamma', '']);
  });
});
