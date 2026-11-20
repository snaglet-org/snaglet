import { agentsApi } from '@desktop/utils/api';
import { NODE_CHIP_MIME, setActiveDragChip } from '@desktop/utils/nodeChip';
/** Pane drops accept sidebar selections and workspace-node chips, but never handler-template chips. */
import type { FC } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { EDITOR_CHIP_MIME } from '@desktop/components/HandlerEditor/editorChip';
import type { DetailSelection } from '../../selection/types';
import { usePaneDropZone } from './usePaneDropZone';

function fakeDataTransfer(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries));
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()];
    },
    dropEffect: 'none',
  };
}

const Harness: FC<{ onDropSelection: (zone: string, sel: DetailSelection) => void }> = ({
  onDropSelection,
}) => {
  const { hoverZone, handlers } = usePaneDropZone(onDropSelection);
  return (
    <div data-testid="pane" {...handlers}>
      <div data-testid="hoverZone">{hoverZone ?? 'none'}</div>
    </div>
  );
};

function renderHarness(onDropSelection = vi.fn()) {
  render(<Harness onDropSelection={onDropSelection} />);
  const pane = screen.getByTestId('pane') as HTMLDivElement;
  // Deterministic hit-test regardless of jsdom's zeroed-out layout — a
  // 100x100 box with (50, 50) landing dead center.
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return { pane, onDropSelection };
}

describe('usePaneDropZone — chip-palette drags are ignored', () => {
  it('never sets hoverZone for a drag carrying only EDITOR_CHIP_MIME', () => {
    const { pane } = renderHarness();
    fireEvent.dragOver(pane, {
      dataTransfer: fakeDataTransfer({ [EDITOR_CHIP_MIME]: '{}' }),
      clientX: 50,
      clientY: 50,
    });
    expect(screen.getByTestId('hoverZone').textContent).toBe('none');
  });

  it('never calls onDropSelection for a drop carrying only EDITOR_CHIP_MIME', () => {
    const { pane, onDropSelection } = renderHarness();
    fireEvent.drop(pane, {
      dataTransfer: fakeDataTransfer({ [EDITOR_CHIP_MIME]: '{}' }),
      clientX: 50,
      clientY: 50,
    });
    expect(onDropSelection).not.toHaveBeenCalled();
  });

  it('does not preventDefault a chip-only drop (never claims it)', () => {
    const { pane } = renderHarness();
    const notPrevented = fireEvent.drop(pane, {
      dataTransfer: fakeDataTransfer({ [EDITOR_CHIP_MIME]: '{}' }),
      clientX: 50,
      clientY: 50,
    });
    // testing-library's fireEvent returns `false` when preventDefault was
    // called on the dispatched event, `true` otherwise.
    expect(notPrevented).toBe(true);
  });
});

describe('usePaneDropZone — real sidebar-node drags still split', () => {
  it('sets hoverZone and calls onDropSelection for a PANE_ITEM_MIME drag/drop', () => {
    const selection = { kind: 'tool', tool: { id: 'tool-1', name: 'weather' } } as DetailSelection;
    const { pane, onDropSelection } = renderHarness();

    fireEvent.dragOver(pane, {
      dataTransfer: fakeDataTransfer({ [PANE_ITEM_MIME]: JSON.stringify(selection) }),
      clientX: 50,
      clientY: 50,
    });
    // The exact zone is not pinned: jsdom's DragEvent does not reliably carry
    // clientX/clientY through fireEvent. The point is that a real sidebar-node
    // drag reaches the zone-setting/commit path, unlike the chip-only cases.
    const zone = screen.getByTestId('hoverZone').textContent;
    expect(zone).not.toBe('none');

    fireEvent.drop(pane, {
      dataTransfer: fakeDataTransfer({ [PANE_ITEM_MIME]: JSON.stringify(selection) }),
      clientX: 50,
      clientY: 50,
    });
    expect(onDropSelection).toHaveBeenCalledWith(zone, selection);
  });
});

afterEach(() => {
  setActiveDragChip(null);
  vi.unstubAllGlobals();
});

describe('node chips dropped from chat and markdown', () => {
  it.each([
    ['doc', 'doc_id'],
    ['thread', 'thread_id'],
    ['container', 'container_id'],
    ['project', 'container_id'],
    ['image', 'image_id'],
  ])('opens a %s chip by canonical id without a sidebar record', (kind, key) => {
    const { pane, onDropSelection } = renderHarness();
    const dataTransfer = fakeDataTransfer({
      [NODE_CHIP_MIME]: JSON.stringify({ kind, id: 'node-1', title: 'Example' }),
    });
    fireEvent.dragOver(pane, { dataTransfer });
    expect(screen.getByTestId('hoverZone')).not.toHaveTextContent('none');
    fireEvent.drop(pane, { dataTransfer });
    expect(onDropSelection).toHaveBeenCalledWith(expect.any(String), {
      kind: kind === 'project' ? 'container' : kind,
      [key]: 'node-1',
    });
  });
  it.each([
    [5, 50, 'left'],
    [95, 50, 'right'],
    [50, 5, 'top'],
    [50, 95, 'bottom'],
    [50, 50, 'center'],
  ])('uses the same pane zone at %s,%s', (x, y, zone) => {
    vi.stubGlobal('DragEvent', MouseEvent);
    const { pane, onDropSelection } = renderHarness();
    const dataTransfer = fakeDataTransfer({
      [NODE_CHIP_MIME]: JSON.stringify({ kind: 'doc', id: 'doc-1' }),
    });
    fireEvent.dragOver(pane, { dataTransfer, clientX: x, clientY: y });
    expect(screen.getByTestId('hoverZone')).toHaveTextContent(String(zone));
    fireEvent.drop(pane, { dataTransfer, clientX: x, clientY: y });
    expect(onDropSelection).toHaveBeenCalledWith(zone, { kind: 'doc', doc_id: 'doc-1' });
  });
  it('supports the native webview drag store when custom MIME is stripped', () => {
    const { pane, onDropSelection } = renderHarness();
    setActiveDragChip({ kind: 'doc', id: 'doc-1' });
    fireEvent.drop(pane, { dataTransfer: fakeDataTransfer({}) });
    expect(onDropSelection).toHaveBeenCalledWith(expect.any(String), {
      kind: 'doc',
      doc_id: 'doc-1',
    });
  });
  it('keeps Shift and nested editor targets reserved for chip insertion', () => {
    vi.stubGlobal('DragEvent', MouseEvent);
    const { pane, onDropSelection } = renderHarness();
    const dataTransfer = fakeDataTransfer({
      [NODE_CHIP_MIME]: JSON.stringify({ kind: 'doc', id: 'doc-1' }),
    });
    fireEvent.drop(pane, { dataTransfer, shiftKey: true });
    const editor = document.createElement('div');
    editor.dataset.paneDropTarget = 'node-chip';
    pane.appendChild(editor);
    fireEvent.dragOver(editor, { dataTransfer });
    fireEvent.drop(editor, { dataTransfer });
    expect(onDropSelection).not.toHaveBeenCalled();
    expect(screen.getByTestId('hoverZone')).toHaveTextContent('none');
  });
  it('ignores malformed payloads', () => {
    const { pane, onDropSelection } = renderHarness();
    fireEvent.drop(pane, { dataTransfer: fakeDataTransfer({ [NODE_CHIP_MIME]: 'broken' }) });
    expect(onDropSelection).not.toHaveBeenCalled();
  });
});

it('does not let a slow agent drop overwrite a newer node drop', async () => {
  let finish!: (agent: Awaited<ReturnType<typeof agentsApi.get>>) => void;
  const spy = vi.spyOn(agentsApi, 'get').mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const { pane, onDropSelection } = renderHarness();
  fireEvent.drop(pane, {
    dataTransfer: fakeDataTransfer({
      [NODE_CHIP_MIME]: JSON.stringify({ kind: 'agent', id: 'agent-1' }),
    }),
  });
  fireEvent.drop(pane, {
    dataTransfer: fakeDataTransfer({
      [NODE_CHIP_MIME]: JSON.stringify({ kind: 'doc', id: 'doc-2' }),
    }),
  });
  await act(async () => {
    finish({ id: 'agent-1' } as Awaited<ReturnType<typeof agentsApi.get>>);
  });
  expect(onDropSelection).toHaveBeenCalledTimes(1);
  expect(onDropSelection).toHaveBeenCalledWith(expect.any(String), {
    kind: 'doc',
    doc_id: 'doc-2',
  });
  spy.mockRestore();
});

describe('usePaneDropZone — the overlay never outlives the drag', () => {
  const selection = { kind: 'providers' } as DetailSelection;

  function hoverPane(pane: HTMLDivElement) {
    fireEvent.dragOver(pane, {
      dataTransfer: fakeDataTransfer({ [PANE_ITEM_MIME]: JSON.stringify(selection) }),
      clientX: 50,
      clientY: 50,
    });
    expect(screen.getByTestId('hoverZone').textContent).not.toBe('none');
  }

  it('clears when the drag is canceled without a dragleave', () => {
    const { pane } = renderHarness();
    hoverPane(pane);

    act(() => {
      window.dispatchEvent(new Event('dragend'));
    });

    expect(screen.getByTestId('hoverZone').textContent).toBe('none');
  });

  it('clears when a nested target claims the drop and stops it', () => {
    const { pane, onDropSelection } = renderHarness();
    hoverPane(pane);
    const inner = screen.getByTestId('hoverZone');
    inner.addEventListener('drop', (event) => event.stopPropagation());

    act(() => {
      inner.dispatchEvent(new Event('drop', { bubbles: true }));
    });

    expect(screen.getByTestId('hoverZone').textContent).toBe('none');
    expect(onDropSelection).not.toHaveBeenCalled();
  });
});
