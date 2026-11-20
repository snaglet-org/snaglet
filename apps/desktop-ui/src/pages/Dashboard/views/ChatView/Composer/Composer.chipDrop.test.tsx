/**
 * Composer — dropping a multi-row sidebar selection inserts one chip per
 * row, in selection order, space-separated, with the caret after the last.
 * Runs the real ChipEditableInput: the drop goes through its ProseMirror
 * handler, and the sent markdown proves the order.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { EditorView } from '@tiptap/pm/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ tables: vi.fn(), agents: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, list: api.tables },
    agentsApi: { ...actual.agentsApi, list: api.agents },
  };
});

import {
  NODE_CHIP_LIST_MIME,
  NODE_CHIP_MIME,
  encodeChipDragList,
  setActiveDragChip,
  setActiveDragChipList,
  type ChipDragList,
  type NodeChipData,
} from '@desktop/utils/nodeChip/payload';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';
import { Composer } from './Composer';

const docA: NodeChipData = { id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Doc A' };
const threadB: NodeChipData = {
  id: 'thread-2222222222222-bbbbbbbbb',
  kind: 'thread',
  title: 'Thread B',
};
const docC: NodeChipData = { id: 'doc-3333333333333-ccccccccc', kind: 'doc', title: 'Doc C' };

/** TipTap hangs its editor on the ProseMirror root element. */
const editorOf = (input: HTMLElement): Editor => (input as HTMLElement & { editor: Editor }).editor;

/** A drop whose payload only survives in the MIME types (in-memory stores empty). */
function dropList(element: HTMLElement, list: ChipDragList, dragged: NodeChipData) {
  const data: Record<string, string> = {
    [NODE_CHIP_LIST_MIME]: encodeChipDragList(list),
    [NODE_CHIP_MIME]: JSON.stringify(dragged),
  };
  const dataTransfer = {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
    dropEffect: 'copy',
    files: [],
  };
  fireEvent.drop(element, { dataTransfer, clientX: 0, clientY: 0 });
}

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

beforeEach(() => {
  localStorage.clear();
  api.agents.mockResolvedValue([]);
  api.tables.mockResolvedValue({ tables: [] });
  vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
    return { pos: this.state.selection.from, inside: -1 };
  });
});

afterEach(() => {
  setActiveDragChip(null);
  setActiveDragChipList(null);
  vi.restoreAllMocks();
});

describe('Composer — multi-row chip drop', () => {
  it('inserts one chip per dropped row, in selection order, caret after the last', async () => {
    const onSubmit = vi.fn();
    render(<Composer threadId="thread-multi-drop" onSubmit={onSubmit} />);
    const input = await screen.findByRole('textbox', { name: 'Message composer' });

    // The drag started on the middle row; the list still leads with Doc A.
    dropList(input, { chips: [docA, threadB, docC], unlinkable: 0 }, threadB);

    await waitFor(() => expect(input.querySelectorAll('.md-chip')).toHaveLength(3));
    expect(
      Array.from(input.querySelectorAll('.md-chip')).map((chip) =>
        chip.getAttribute('data-node-url')
      )
    ).toEqual([docA.id, threadB.id, docC.id]);

    // The caret sits right after the last chip, so typing continues there.
    const { selection } = editorOf(input).state;
    expect(selection.empty).toBe(true);
    expect(selection.$from.nodeBefore?.attrs.href).toBe(docC.id);
    expect(selection.$from.nodeAfter).toBeNull();

    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      `[Doc A](${docA.id}) [Thread B](${threadB.id}) [Doc C](${docC.id})`
    );
  });

  it('skips rows with no chip form and says so in a toast', async () => {
    const toasts: string[] = [];
    const onToast = (event: Event) =>
      toasts.push((event as CustomEvent<ToastDetail>).detail.message);
    window.addEventListener(TOAST_EVENT_NAME, onToast);
    try {
      const onSubmit = vi.fn();
      render(<Composer threadId="thread-multi-drop-skip" onSubmit={onSubmit} />);
      const input = await screen.findByRole('textbox', { name: 'Message composer' });
      dropList(input, { chips: [docA, docC], unlinkable: 1 }, docA);

      await waitFor(() => expect(input.querySelectorAll('.md-chip')).toHaveLength(2));
      expect(toasts).toEqual(["Skipped 1 item that can't be linked here"]);
    } finally {
      window.removeEventListener(TOAST_EVENT_NAME, onToast);
    }
  });
});
