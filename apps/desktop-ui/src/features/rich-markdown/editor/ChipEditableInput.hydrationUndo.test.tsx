/**
 * Undo history around external value hydration.
 *
 * ChipEditableInput mounts empty and then loads its `value` prop. That load
 * (and any later external reload) is not an edit the user made, so undo must
 * never step back through it to an empty or stale editor. The user's own
 * typing and chip insertions stay undoable as usual.
 */
import { useState } from 'react';
import type { Editor } from '@tiptap/react';
import { undoDepth } from '@tiptap/pm/history';
import { EditorView } from '@tiptap/pm/view';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { NODE_CHIP_MIME, setActiveDragChip, type NodeChipData } from '@desktop/utils/nodeChip';
import { ChipEditableInput } from './ChipEditableInput';

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';
const CHIP_MARKDOWN = `See [Field guide](${DOC_ID})`;

let editor: Editor | null = null;
let setExternal: (value: string) => void = () => undefined;

/** A controlled host: typing round-trips through state; `setExternal` is a reload. */
function Host({
  initial,
  richBlocks,
  onValue,
}: {
  initial: string;
  richBlocks: boolean;
  onValue: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  setExternal = setValue;
  return (
    <ChipEditableInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
      onEditorReady={(next) => {
        editor = next;
      }}
      richBlocks={richBlocks}
      multiline={richBlocks}
      ariaLabel="Note"
      enableNodeMentions={false}
    />
  );
}

async function mount(initial: string, richBlocks = false) {
  const onValue = vi.fn();
  render(<Host initial={initial} richBlocks={richBlocks} onValue={onValue} />);
  const box = await screen.findByRole('textbox', { name: 'Note' });
  await waitFor(() => expect(editor).not.toBeNull());
  return { box, onValue, ed: () => editor as Editor };
}

/** The real undo keybinding (TipTap binds Mod-z; jsdom is not a Mac). */
function pressUndo(box: HTMLElement) {
  const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
  fireEvent.keyDown(box, { key: 'z', code: 'KeyZ', metaKey: mac, ctrlKey: !mac });
}

describe('ChipEditableInput hydration is not undoable', () => {
  // jsdom has no layout; focus and selection scrolling need these to exist.
  beforeAll(() => {
    if (!document.elementFromPoint) document.elementFromPoint = () => null;
    if (!Range.prototype.getClientRects)
      Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    if (!Range.prototype.getBoundingClientRect)
      Range.prototype.getBoundingClientRect = () => new DOMRect();
  });
  beforeEach(() => {
    editor = null;
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
      return { pos: this.state.selection.from, inside: -1 };
    });
  });
  afterEach(() => {
    setActiveDragChip(null);
    vi.restoreAllMocks();
  });

  it.each([
    ['plain', false],
    ['rich', true],
  ] as const)('%s: undo right after the initial load keeps the loaded value', async (_, rich) => {
    const { box, onValue, ed } = await mount('Saved text', rich);
    await waitFor(() => expect(box).toHaveTextContent('Saved text'));
    expect(undoDepth(ed().state)).toBe(0);

    pressUndo(box);
    expect(box).toHaveTextContent('Saved text');
    expect(onValue).not.toHaveBeenCalled();
  });

  it('undo after an external reload neither empties nor restores the replaced value', async () => {
    const { box, ed } = await mount('Old draft');
    await waitFor(() => expect(box).toHaveTextContent('Old draft'));

    act(() => setExternal('Newer saved text'));
    await waitFor(() => expect(box).toHaveTextContent('Newer saved text'));
    expect(undoDepth(ed().state)).toBe(0);

    pressUndo(box);
    expect(box).toHaveTextContent('Newer saved text');
    expect(box).not.toHaveTextContent('Old draft');
  });

  it('still undoes the user’s own edit back to the loaded value, not past it', async () => {
    const { box, onValue, ed } = await mount('Saved text');
    await waitFor(() => expect(box).toHaveTextContent('Saved text'));

    act(() => {
      ed().chain().focus('end').insertContent(' and more').run();
    });
    expect(box).toHaveTextContent('Saved text and more');
    expect(onValue).toHaveBeenLastCalledWith('Saved text and more');
    expect(undoDepth(ed().state)).toBe(1);

    pressUndo(box);
    expect(box).toHaveTextContent('Saved text');
    expect(box).not.toHaveTextContent('and more');
    expect(onValue).toHaveBeenLastCalledWith('Saved text');

    pressUndo(box);
    expect(box).toHaveTextContent('Saved text');
  });

  it('keeps a hydrated chip through undo', async () => {
    const { box, onValue, ed } = await mount(CHIP_MARKDOWN);
    await waitFor(() => expect(box.querySelector(`[data-node-url="${DOC_ID}"]`)).not.toBeNull());
    expect(undoDepth(ed().state)).toBe(0);

    pressUndo(box);
    expect(box.querySelector(`[data-node-url="${DOC_ID}"]`)).not.toBeNull();
    expect(box).toHaveTextContent('See');
    expect(onValue).not.toHaveBeenCalled();
  });

  it('undoes a dropped chip back to the loaded value', async () => {
    const chip: NodeChipData = { id: DOC_ID, kind: 'doc', title: 'Field guide' };
    const { box, onValue, ed } = await mount('Saved text');
    await waitFor(() => expect(box).toHaveTextContent('Saved text'));
    act(() => {
      ed().commands.focus('end');
    });

    fireEvent.drop(box, {
      dataTransfer: {
        types: [NODE_CHIP_MIME],
        getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(chip) : ''),
        dropEffect: 'copy',
        files: [],
      },
      clientX: 0,
      clientY: 0,
    });
    await waitFor(() => expect(box.querySelector(`[data-node-url="${DOC_ID}"]`)).not.toBeNull());

    pressUndo(box);
    await waitFor(() => expect(box.querySelector(`[data-node-url="${DOC_ID}"]`)).toBeNull());
    expect(box).toHaveTextContent('Saved text');
    expect(onValue).toHaveBeenLastCalledWith('Saved text');
  });
});
