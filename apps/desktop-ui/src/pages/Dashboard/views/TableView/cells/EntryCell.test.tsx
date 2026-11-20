import type { ComponentProps, ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField } from '@snaglet/shared/types';
import {
  NODE_CHIP_MIME,
  setActiveDragChip,
  setActiveDragChipList,
  writeChipDragList,
  type NodeChipData,
} from '@desktop/utils/nodeChip/payload';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';
import { EntryCell } from './EntryCell';
import styles from '../TableEntries.module.scss';

const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: 'table-1111111111111-aaaaaaaaa',
  columnName: 'summary',
  name: 'summary',
  description: null,
  type: 'text',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  revision: 1,
};
const chip: NodeChipData = {
  id: 'doc-1111111111111-aaaaaaaaa',
  kind: 'doc',
  title: 'Field guide',
};
function transfer() {
  return {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(chip) : ''),
    dropEffect: 'copy',
    files: [],
  };
}
function drop(target: HTMLElement) {
  const dataTransfer = transfer();
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}
function renderCell(props: ComponentProps<typeof EntryCell> = {}, children?: ReactNode) {
  const paneDrop = vi.fn();
  const view = render(
    <>
      <button>Outside grid</button>
      <div data-table-entries-grid onDrop={paneDrop}>
        <table>
          <tbody>
            <tr>
              <EntryCell data-testid="cell" field={field} {...props}>
                {children ?? <button>Cell value</button>}
              </EntryCell>
              <td>
                <button>Other cell</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
  return { ...view, cell: screen.getByTestId('cell'), paneDrop };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setActiveDragChip(null);
  setActiveDragChipList(null);
});

describe('EntryCell drop ownership and notices', () => {
  it.each(['number', 'date', 'relation'] as const)(
    'owns active %s rejection outside row flow',
    (type) => {
      const { cell, paneDrop } = renderCell(
        { active: true, field: { ...field, type } },
        <div data-pane-drop-target="node-chip" data-testid="editor">
          <input aria-label="Value" />
        </div>
      );
      const nestedDrop = vi.fn();
      screen.getByTestId('editor').addEventListener('drop', nestedDrop);
      drop(screen.getByRole('textbox'));
      expect(nestedDrop).not.toHaveBeenCalled();
      expect(paneDrop).not.toHaveBeenCalled();
      expect(cell).not.toContainElement(screen.getByRole('alert'));
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }
  );

  it('lets a native nested editor own dragover and drop without retaining outer hover', () => {
    const onChipDrop = vi.fn().mockResolvedValue(true);
    const { cell, paneDrop } = renderCell(
      { active: true, onChipDrop },
      <div data-pane-drop-target="node-chip" data-testid="editor">
        Editor
      </div>
    );
    const editor = screen.getByTestId('editor');
    const nativeOver = vi.fn((event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    });
    const nativeDrop = vi.fn((event: Event) => event.preventDefault());
    editor.addEventListener('dragover', nativeOver);
    editor.addEventListener('drop', nativeDrop);
    const dataTransfer = transfer();
    fireEvent.dragOver(cell, { dataTransfer });
    expect(cell).toHaveClass(styles.dropReady);
    fireEvent.dragOver(editor, { dataTransfer });
    expect(nativeOver).toHaveBeenCalledOnce();
    expect(cell).not.toHaveClass(styles.dropReady);
    expect(dataTransfer.dropEffect).toBe('link');
    fireEvent.drop(editor, { dataTransfer });
    expect(nativeDrop).toHaveBeenCalledOnce();
    expect(onChipDrop).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the cell border as a drop fallback beside a nested editor', async () => {
    const onChipDrop = vi.fn().mockResolvedValue(true);
    const { cell, paneDrop } = renderCell(
      { active: true, onChipDrop },
      <div data-pane-drop-target="node-chip">Editor</div>
    );
    await act(async () => drop(cell));
    expect(onChipDrop).toHaveBeenCalledExactlyOnceWith([chip]);
    expect(paneDrop).not.toHaveBeenCalled();
    expect(cell).not.toHaveClass(styles.dropReady);
  });

  it('uses contextual rejection reasons and blocks the pane split', () => {
    const onChipDrop = vi.fn().mockResolvedValue(true);
    const { cell, paneDrop } = renderCell({
      onChipDrop,
      rejectReason: 'Expand this column to add a link',
    });
    drop(cell);
    expect(screen.getByRole('alert')).toHaveTextContent('Expand this column to add a link');
    expect(onChipDrop).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
  });

  it('uses a specific blocked reason while retaining ownership over nested editors', () => {
    const { cell } = renderCell(
      { active: true, blocked: true, rejectReason: 'Close field settings to edit entries.' },
      <div data-pane-drop-target="node-chip" data-testid="editor">
        Editor
      </div>
    );
    const nativeDrop = vi.fn();
    screen.getByTestId('editor').addEventListener('drop', nativeDrop);
    drop(screen.getByTestId('editor'));
    expect(screen.getByRole('alert')).toHaveTextContent('Close field settings to edit entries.');
    expect(nativeDrop).not.toHaveBeenCalled();
    expect(cell).not.toHaveClass(styles.dropRejected);
  });

  it('uses the unavailable fallback when blocked without a specific reason', () => {
    const { cell } = renderCell({ blocked: true });
    drop(cell);
    expect(screen.getByRole('alert')).toHaveTextContent('Editing is unavailable');
  });

  it('portals a viewport-clamped notice outside the cell without adding row content', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.tagName === 'TD'
        ? new DOMRect(window.innerWidth - 40, window.innerHeight - 28, 34, 36)
        : new DOMRect(0, 0, 280, 60);
    });
    const { cell } = renderCell({ rejectReason: 'Expand this column to add a link' });
    drop(cell);
    const notice = screen.getByRole('alert');
    expect(notice.parentElement).toBe(document.body);
    expect(cell).not.toContainElement(notice);
    expect(notice).toHaveStyle({
      left: `${window.innerWidth - 288}px`,
      top: `${window.innerHeight - 92}px`,
    });
  });

  it('keeps a rejected drop readable through terminal dragend, then expires after three seconds', () => {
    const { cell } = renderCell({ field: { ...field, type: 'number' } });
    drop(cell);
    fireEvent.dragEnd(window);
    act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByRole('alert')).toHaveTextContent("Number cells can't hold links");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('restarts the notice lifetime on a repeated rejection', () => {
    const { cell } = renderCell({ field: { ...field, type: 'number' } });
    drop(cell);
    act(() => vi.advanceTimersByTime(2000));
    drop(cell);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['escape', 'grid pointerdown', 'dragstart', 'scroll', 'resize'])(
    'dismisses the notice on %s',
    (interaction) => {
      const { cell } = renderCell({ field: { ...field, type: 'number' } });
      drop(cell);
      if (interaction === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
      else if (interaction === 'grid pointerdown')
        fireEvent.pointerDown(screen.getByRole('button', { name: 'Other cell' }));
      else if (interaction === 'dragstart') fireEvent.dragStart(window);
      else if (interaction === 'scroll') fireEvent.scroll(window);
      else fireEvent.resize(window);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }
  );

  it('does not dismiss on pointerdown outside the grid', () => {
    const { cell } = renderCell({ field: { ...field, type: 'number' } });
    drop(cell);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside grid' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('reports a failed editable-cell handoff with the same notice lifecycle', async () => {
    const onChipDrop = vi.fn().mockResolvedValue(false);
    const { cell } = renderCell({ onChipDrop });
    await act(async () => drop(cell));
    expect(screen.getByRole('alert')).toHaveTextContent('Link not added');
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('EntryCell multi-row drops', () => {
  const docB: NodeChipData = { id: 'doc-2222222222222-bbbbbbbbb', kind: 'doc', title: 'Doc B' };
  const threadC: NodeChipData = {
    id: 'thread-3333333333333-ccccccccc',
    kind: 'thread',
    title: 'Thread C',
  };
  const docRelation: TableField = { ...field, type: 'relation', referenceKind: 'doc' };

  function dropSelection(target: HTMLElement, chips: NodeChipData[], unlinkable = 0) {
    writeChipDragList({ setData: () => {} } as unknown as DataTransfer, { chips, unlinkable });
    drop(target);
  }

  function captureToasts() {
    const messages: string[] = [];
    const listener = (event: Event) =>
      messages.push((event as CustomEvent<ToastDetail>).detail.message);
    window.addEventListener(TOAST_EVENT_NAME, listener);
    return { messages, stop: () => window.removeEventListener(TOAST_EVENT_NAME, listener) };
  }

  it('hands a Text cell every dropped chip, in selection order', async () => {
    const onChipDrop = vi.fn().mockResolvedValue(true);
    const { cell } = renderCell({ onChipDrop });
    await act(async () => dropSelection(cell, [docB, chip, threadC]));
    expect(onChipDrop).toHaveBeenCalledExactlyOnceWith([docB, chip, threadC]);
  });

  it('a multiple relation takes the chips that fit and toasts the skipped ones', async () => {
    const toasts = captureToasts();
    try {
      const onChipDrop = vi.fn().mockResolvedValue(true);
      const { cell } = renderCell({ onChipDrop, field: { ...docRelation, multiple: true } });
      await act(async () => dropSelection(cell, [docB, threadC, chip], 1));
      expect(onChipDrop).toHaveBeenCalledExactlyOnceWith([docB, chip]);
      expect(toasts.messages).toEqual(["Skipped 2 items that can't be linked here"]);
    } finally {
      toasts.stop();
    }
  });

  it('a single-value relation links the first chip that fits', async () => {
    const onChipDrop = vi.fn().mockResolvedValue(true);
    const { cell } = renderCell({ onChipDrop, field: docRelation });
    await act(async () => dropSelection(cell, [threadC, docB, chip]));
    expect(onChipDrop).toHaveBeenCalledExactlyOnceWith([docB]);
  });

  it('refuses with the field guidance when no dropped chip fits', async () => {
    const onChipDrop = vi.fn().mockResolvedValue(true);
    const { cell } = renderCell({ onChipDrop, field: docRelation });
    await act(async () => dropSelection(cell, [threadC, threadC]));
    expect(onChipDrop).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('This field links to');
  });
});
