/**
 * Doc editor — dropping a sidebar selection (one row or several) into a doc body
 * inserts one chip per row, in selection order, space-separated, with the
 * caret after the last. Runs the real ChipEditableInput inside the
 * `doc-body` WorkspaceEditor, the surface DocView renders.
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
  NODE_CHIP_MIME,
  setActiveDragChip,
  setActiveDragChipList,
  writeChipDragData,
  writeChipDragList,
  type NodeChipData,
} from '@desktop/utils/nodeChip/payload';
import { WorkspaceEditor } from './WorkspaceEditor';

const docA: NodeChipData = { id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Doc A' };
const tableB: NodeChipData = {
  id: 'table-2222222222222-bbbbbbbbb',
  kind: 'table',
  title: 'Table B',
};
const threadC: NodeChipData = {
  id: 'thread-3333333333333-ccccccccc',
  kind: 'thread',
  title: 'Thread C',
};

const editorOf = (input: HTMLElement): Editor => (input as HTMLElement & { editor: Editor }).editor;

/**
 * A drop as WKWebView delivers it: no readable MIME types, so the payload
 * comes from the in-memory stores the drag source filled at dragstart.
 */
function dropFromMemory(element: HTMLElement) {
  const dataTransfer = { types: [], getData: () => '', dropEffect: 'copy', files: [] };
  fireEvent.drop(element, { dataTransfer, clientX: 0, clientY: 0 });
}

function dropSingle(element: HTMLElement, chip: NodeChipData) {
  const dataTransfer = {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(chip) : ''),
    dropEffect: 'copy',
    files: [],
  };
  fireEvent.drop(element, { dataTransfer, clientX: 0, clientY: 0 });
}

/** What a sidebar drag source writes at dragstart for a three-row selection. */
function startMultiRowDrag() {
  const sink = { setData: () => {} } as unknown as DataTransfer;
  writeChipDragData(sink, tableB);
  writeChipDragList(sink, { chips: [docA, tableB, threadC], unlinkable: 0 });
}

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

beforeEach(() => {
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

describe('Doc editor — multi-row chip drop', () => {
  it('inserts one chip per row in selection order and saves them in that order', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceEditor kind="doc-body" savedValue="" onSave={onSave} autosaveDelayMs={0} />);
    const input = await screen.findByRole('textbox', { name: 'Doc body' });

    startMultiRowDrag();
    dropFromMemory(input);

    await waitFor(() => expect(input.querySelectorAll('.md-chip')).toHaveLength(3));
    expect(
      Array.from(input.querySelectorAll('.md-chip')).map((chip) =>
        chip.getAttribute('data-node-url')
      )
    ).toEqual([docA.id, `table:${tableB.id}`, threadC.id]);

    const { selection } = editorOf(input).state;
    expect(selection.empty).toBe(true);
    expect(selection.$from.nodeBefore?.attrs.href).toBe(threadC.id);

    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith(
        `[Doc A](${docA.id}) [Table B](table:${tableB.id}) [Thread C](${threadC.id})`
      )
    );
  });

  it('a single-row drop still inserts just that chip', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceEditor kind="doc-body" savedValue="" onSave={onSave} autosaveDelayMs={0} />);
    const input = await screen.findByRole('textbox', { name: 'Doc body' });

    dropSingle(input, docA);

    await waitFor(() => expect(input.querySelectorAll('.md-chip')).toHaveLength(1));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(`[Doc A](${docA.id})`));
  });

  it('a single-row drop away from the caret leaves the caret after the chip', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkspaceEditor
        kind="doc-body"
        savedValue="Intro text"
        onSave={onSave}
        autosaveDelayMs={0}
      />
    );
    const input = await screen.findByRole('textbox', { name: 'Doc body' });
    await waitFor(() => expect(input).toHaveTextContent('Intro text'));
    const editor = editorOf(input);
    editor.commands.setTextSelection(1);
    // The drop lands at the end of the paragraph, not at the caret.
    const end = editor.state.doc.content.size - 1;
    vi.mocked(EditorView.prototype.posAtCoords).mockReturnValue({ pos: end, inside: -1 });

    dropSingle(input, docA);

    await waitFor(() => expect(input.querySelectorAll('.md-chip')).toHaveLength(1));
    const { selection } = editor.state;
    expect(selection.empty).toBe(true);
    expect(selection.$from.nodeBefore?.attrs.href).toBe(docA.id);
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(`Intro text[Doc A](${docA.id})`));
  });
});
