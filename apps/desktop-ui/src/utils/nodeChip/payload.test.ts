/**
 * nodeChip payload — gesture scoping of the in-memory drag store. The store
 * exists as a WKWebView fallback but is checked first by readChipDragData,
 * so a chip that outlived its drag would hijack the next gesture. The
 * capture-phase window listeners in payload.ts scope it to a single drag.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PANE_ITEM_MIME } from '../paneDrag';
import {
  getActiveDragChip,
  readChipDragData,
  setActiveDragChip,
  type NodeChipData,
} from './payload';

const toolChip: NodeChipData = { id: 'diff_files', kind: 'tool', title: 'Diff Files' };

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

describe('nodeChip in-memory store — gesture scoping', () => {
  beforeEach(() => setActiveDragChip(null));

  it('a new dragstart clears a leftover chip before any source handler runs', () => {
    setActiveDragChip(toolChip);
    window.dispatchEvent(new Event('dragstart'));
    expect(getActiveDragChip()).toBeNull();
  });

  it('dragend clears the store even when the source wired no onDragEnd', () => {
    setActiveDragChip(toolChip);
    window.dispatchEvent(new Event('dragend'));
    expect(getActiveDragChip()).toBeNull();
  });

  it('a chip written during the gesture survives — only leftovers are dropped', () => {
    // Real ordering: window capture clear fires first, then the source's own
    // dragstart handler (React bubble at the app root) writes the fresh chip.
    setActiveDragChip({ id: 'stale-tool', kind: 'tool', title: 'Stale' });
    window.dispatchEvent(new Event('dragstart'));
    setActiveDragChip(toolChip);
    expect(getActiveDragChip()).toEqual(toolChip);
  });

  it('maps an agent-row PANE_ITEM_MIME payload to an agent chip (nested principal shape)', () => {
    const dt = fakeDataTransfer({
      [PANE_ITEM_MIME]: JSON.stringify({ kind: 'agent', agent: { id: 'clio', name: 'Clio' } }),
    });
    expect(readChipDragData(dt)).toEqual({
      id: 'clio',
      kind: 'agent',
      title: 'Clio',
      name: 'Clio',
    });
  });

  it('a stale tool chip does not hijack a later agent-row drag', () => {
    // 1. Tool drag happened; its dragend was never delivered (or the source
    //    forgot to clear) — the store still holds the tool.
    setActiveDragChip(toolChip);
    // 2. User starts dragging an agent row — agents carry only
    //    PANE_ITEM_MIME (no chip payload).
    window.dispatchEvent(new Event('dragstart'));
    const dt = fakeDataTransfer({
      [PANE_ITEM_MIME]: JSON.stringify({ kind: 'agent', agent: { id: 'agent-7', name: 'Rosie' } }),
    });
    // 3. The drop must resolve to the agent being dragged, never the
    //    stale tool from the previous gesture.
    expect(readChipDragData(dt)).toEqual({
      id: 'agent-7',
      kind: 'agent',
      title: 'Rosie',
      name: 'Rosie',
    });
  });
});
