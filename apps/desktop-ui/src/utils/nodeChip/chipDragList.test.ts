/**
 * Multi-item chip drags — the list a multi-row sidebar drag carries next to
 * its single chip, and how drop targets read it back. The single-chip
 * flavors keep naming the dragged row, so one-item consumers are unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PANE_ITEM_MIME } from '../paneDrag';
import { TOAST_EVENT_NAME, type ToastDetail } from '../toast';
import { acceptDroppedChips, skippedChipsMessage } from './chipDrop';
import {
  NODE_CHIP_LIST_MIME,
  NODE_CHIP_MIME,
  chipDragListOf,
  decodeChipDragList,
  encodeChipDragList,
  hasChipDragData,
  isMultiChipDrag,
  readChipDragData,
  readChipDragList,
  setActiveDragChip,
  setActiveDragChipList,
  writeChipDragData,
  writeChipDragList,
  type ChipDragList,
  type NodeChipData,
} from './payload';

const docA: NodeChipData = { id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Doc A' };
const threadB: NodeChipData = {
  id: 'thread-2222222222222-bbbbbbbbb',
  kind: 'thread',
  title: 'Thread B',
};
const tableC: NodeChipData = {
  id: 'table-3333333333333-ccccccccc',
  kind: 'table',
  title: 'Table C',
};

function fakeDataTransfer(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()];
    },
  } as unknown as DataTransfer;
}

function captureToasts(): { messages: string[]; stop: () => void } {
  const messages: string[] = [];
  const listener = (event: Event) =>
    messages.push((event as CustomEvent<ToastDetail>).detail.message);
  window.addEventListener(TOAST_EVENT_NAME, listener);
  return { messages, stop: () => window.removeEventListener(TOAST_EVENT_NAME, listener) };
}

afterEach(() => {
  setActiveDragChip(null);
  setActiveDragChipList(null);
});

describe('chipDragListOf', () => {
  it('keeps the rows in the given order and counts kinds with no chip form', () => {
    const list = chipDragListOf([
      { id: docA.id, kind: 'doc', title: 'Doc A' },
      { id: 'board-4444444444444-ddddddddd', kind: 'board', title: 'Board D' },
      { id: threadB.id, kind: 'thread', title: 'Thread B' },
      { id: tableC.id, kind: 'table', title: 'Table C' },
    ]);
    expect(list).toEqual({ chips: [docA, threadB, tableC], unlinkable: 1 });
    expect(isMultiChipDrag(list)).toBe(true);
  });

  it('a single row is not a multi-item drag', () => {
    expect(isMultiChipDrag(chipDragListOf([{ id: docA.id, kind: 'doc' }]))).toBe(false);
  });
});

describe('encodeChipDragList / decodeChipDragList', () => {
  it('round-trips a list in order', () => {
    const list: ChipDragList = { chips: [docA, threadB, tableC], unlinkable: 2 };
    expect(decodeChipDragList(encodeChipDragList(list))).toEqual(list);
  });

  it('counts malformed or unknown-kind entries as unlinkable instead of dropping them silently', () => {
    const raw = JSON.stringify({
      chips: [docA, { id: 'x', kind: 'not-a-kind' }, { kind: 'doc' }, 'junk', threadB],
      unlinkable: 1,
    });
    expect(decodeChipDragList(raw)).toEqual({ chips: [docA, threadB], unlinkable: 4 });
  });

  it('rejects empty, unparseable and wrongly shaped payloads', () => {
    expect(decodeChipDragList('')).toBeNull();
    expect(decodeChipDragList(null)).toBeNull();
    expect(decodeChipDragList('{not json')).toBeNull();
    expect(decodeChipDragList(JSON.stringify({ chips: 'doc' }))).toBeNull();
    expect(decodeChipDragList(JSON.stringify([docA]))).toBeNull();
    expect(decodeChipDragList(JSON.stringify({ chips: [], unlinkable: 0 }))).toBeNull();
  });
});

describe('readChipDragList', () => {
  it('reads the in-memory list first (WKWebView drops custom MIME types)', () => {
    const dt = fakeDataTransfer();
    writeChipDragList(dt, { chips: [docA, threadB], unlinkable: 0 });
    expect(readChipDragList(fakeDataTransfer())).toEqual({
      chips: [docA, threadB],
      unlinkable: 0,
    });
  });

  it('falls back to the list MIME when the in-memory store is empty', () => {
    const list: ChipDragList = { chips: [tableC, docA, threadB], unlinkable: 0 };
    const dt = fakeDataTransfer({ [NODE_CHIP_LIST_MIME]: encodeChipDragList(list) });
    expect(readChipDragList(dt)).toEqual(list);
    expect(hasChipDragData(dt)).toBe(true);
  });

  it('wraps a single-chip drag as a one-item list (old producers keep working)', () => {
    const dt = fakeDataTransfer({ [NODE_CHIP_MIME]: JSON.stringify(docA) });
    expect(readChipDragList(dt)).toEqual({ chips: [docA], unlinkable: 0 });
  });

  it('wraps a pane-item-only drag the same way', () => {
    const dt = fakeDataTransfer({
      [PANE_ITEM_MIME]: JSON.stringify({ kind: 'doc', doc_id: docA.id, node: { title: 'Doc A' } }),
    });
    expect(readChipDragList(dt)).toEqual({
      chips: [{ id: docA.id, kind: 'doc', title: 'Doc A', name: null }],
      unlinkable: 0,
    });
  });

  it('returns null when the drag carries no chip at all', () => {
    expect(readChipDragList(fakeDataTransfer({ Files: '' }))).toBeNull();
  });

  it('leaves the single-chip read naming the dragged row', () => {
    const dt = fakeDataTransfer();
    writeChipDragData(dt, threadB);
    writeChipDragList(dt, { chips: [docA, threadB, tableC], unlinkable: 0 });
    expect(readChipDragData(dt)).toEqual(threadB);
  });

  it('a new gesture clears a leftover list before any source writes', () => {
    writeChipDragList(fakeDataTransfer(), { chips: [docA, threadB], unlinkable: 0 });
    window.dispatchEvent(new Event('dragstart'));
    expect(readChipDragList(fakeDataTransfer())).toBeNull();
    writeChipDragList(fakeDataTransfer(), { chips: [docA, threadB], unlinkable: 0 });
    window.dispatchEvent(new Event('dragend'));
    expect(readChipDragList(fakeDataTransfer())).toBeNull();
  });
});

describe('acceptDroppedChips', () => {
  it('keeps the accepted chips in order and toasts once for every skipped item', () => {
    const toasts = captureToasts();
    try {
      const chips = acceptDroppedChips(
        { chips: [docA, threadB, tableC], unlinkable: 1 },
        (chip) => chip.kind !== 'thread'
      );
      expect(chips).toEqual([docA, tableC]);
      expect(toasts.messages).toEqual([skippedChipsMessage(2)]);
      expect(skippedChipsMessage(2)).toBe("Skipped 2 items that can't be linked here");
    } finally {
      toasts.stop();
    }
  });

  it('does not toast when every item is taken', () => {
    const toasts = captureToasts();
    try {
      expect(acceptDroppedChips({ chips: [docA, threadB], unlinkable: 0 })).toEqual([
        docA,
        threadB,
      ]);
      expect(toasts.messages).toEqual([]);
    } finally {
      toasts.stop();
    }
  });

  it('keeps a refused single-item drag silent, as before', () => {
    const toasts = captureToasts();
    try {
      expect(acceptDroppedChips({ chips: [threadB], unlinkable: 0 }, () => false)).toEqual([]);
      expect(toasts.messages).toEqual([]);
      expect(skippedChipsMessage(1)).toBe("Skipped 1 item that can't be linked here");
    } finally {
      toasts.stop();
    }
  });
});
