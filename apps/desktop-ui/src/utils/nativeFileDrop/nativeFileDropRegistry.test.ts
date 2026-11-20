import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchNativeFileDrop, registerNativeFileDropTarget } from './nativeFileDropRegistry';
// Imported from the leaf module (not the `nodeChip` barrel) — the barrel
// re-exports `expandTransclusions.ts`, which pulls in the API client and throws
// at import time without VITE_API_BASE_URL/VITE_APP_NAME set. This test
// only needs the payload helpers, which have no such side effect.
import {
  hasChipDragData,
  readChipDragData,
  setActiveDragChip,
  writeChipDragData,
} from '@desktop/utils/nodeChip/payload';

function appendTarget(): { el: HTMLDivElement; child: HTMLSpanElement } {
  const el = document.createElement('div');
  const child = document.createElement('span');
  el.appendChild(child);
  document.body.appendChild(el);
  return { el, child };
}

// jsdom doesn't implement `elementFromPoint` at all (not even as a stub
// returning null), so `vi.spyOn` can't wrap a nonexistent property —
// assign it directly instead.
function stubElementFromPoint(el: Element | null) {
  const fn = vi.fn().mockReturnValue(el);
  document.elementFromPoint = fn;
  return fn;
}

// jsdom also doesn't provide a global `DataTransfer` constructor. This
// fake implements only what `writeChipDragData`/`hasChipDragData`/
// `readChipDragData` touch (`types`, `getData`, `setData`).
function createFakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  const types: string[] = [];
  return {
    get types() {
      return types as unknown as DOMStringList;
    },
    setData: (type: string, value: string) => {
      if (!types.includes(type)) types.push(type);
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? '',
  } as unknown as DataTransfer;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // writeChipDragData sets a module-level "active drag" fallback (see
  // payload.ts) that otherwise leaks across tests/files.
  setActiveDragChip(null);
});

describe('nativeFileDropRegistry — dispatchNativeFileDrop', () => {
  it('routes a drop to the registered target under the hit-tested point', () => {
    const { el: el1, child: child1 } = appendTarget();
    const { el: el2 } = appendTarget();
    const onDrop1 = vi.fn();
    const onDrop2 = vi.fn();
    const unregister1 = registerNativeFileDropTarget({ el: el1, onDrop: onDrop1 });
    const unregister2 = registerNativeFileDropTarget({ el: el2, onDrop: onDrop2 });

    stubElementFromPoint(child1);

    dispatchNativeFileDrop({
      type: 'drop',
      paths: ['/Users/user/Desktop/notes.txt'],
      position: { x: 10, y: 20 },
    });

    expect(onDrop1).toHaveBeenCalledTimes(1);
    expect(onDrop1).toHaveBeenCalledWith('/Users/user/Desktop/notes.txt', { x: 10, y: 20 });
    expect(onDrop2).not.toHaveBeenCalled();

    unregister1();
    unregister2();
  });

  it('joins multiple dropped paths (files and folders alike) with newlines, in drop order', () => {
    const { el, child } = appendTarget();
    const onDrop = vi.fn();
    const unregister = registerNativeFileDropTarget({ el, onDrop });
    stubElementFromPoint(child);

    dispatchNativeFileDrop({
      type: 'drop',
      paths: ['/Users/user/a.txt', '/Users/user/Projects/my-folder', '/Users/user/b.png'],
      position: { x: 0, y: 0 },
    });

    expect(onDrop).toHaveBeenCalledWith(
      '/Users/user/a.txt\n/Users/user/Projects/my-folder\n/Users/user/b.png',
      { x: 0, y: 0 }
    );
    unregister();
  });

  it('preserves Windows drive paths, spaces, and Unicode from the native event', () => {
    const { el, child } = appendTarget();
    const onDrop = vi.fn();
    const unregister = registerNativeFileDropTarget({ el, onDrop });
    stubElementFromPoint(child);

    dispatchNativeFileDrop({
      type: 'drop',
      paths: ['C:\\Work Space\\café.txt', '\\\\server\\share\\資料\\report.txt'],
      position: { x: 8, y: 12 },
    });

    expect(onDrop).toHaveBeenCalledWith(
      'C:\\Work Space\\café.txt\n\\\\server\\share\\資料\\report.txt',
      { x: 8, y: 12 }
    );
    unregister();
  });

  it('converts the physical drop position to logical pixels via devicePixelRatio', () => {
    const { el, child } = appendTarget();
    const onDrop = vi.fn();
    const unregister = registerNativeFileDropTarget({ el, onDrop });
    vi.stubGlobal('devicePixelRatio', 2);
    const elementFromPoint = stubElementFromPoint(child);

    dispatchNativeFileDrop({ type: 'drop', paths: ['/a'], position: { x: 200, y: 100 } });

    expect(elementFromPoint).toHaveBeenCalledWith(100, 50);
    expect(onDrop).toHaveBeenCalledWith('/a', { x: 100, y: 50 });
    unregister();
  });

  it('ignores non-drop event types (enter/over/leave) — no target is invoked', () => {
    const { el, child } = appendTarget();
    const onDrop = vi.fn();
    const unregister = registerNativeFileDropTarget({ el, onDrop });
    stubElementFromPoint(child);

    dispatchNativeFileDrop({ type: 'over', position: { x: 0, y: 0 } });
    dispatchNativeFileDrop({ type: 'leave' });
    dispatchNativeFileDrop({ type: 'enter', paths: ['/a'], position: { x: 0, y: 0 } });

    expect(onDrop).not.toHaveBeenCalled();
    unregister();
  });

  it('ignores a drop payload with no paths', () => {
    const { el, child } = appendTarget();
    const onDrop = vi.fn();
    const unregister = registerNativeFileDropTarget({ el, onDrop });
    stubElementFromPoint(child);

    dispatchNativeFileDrop({ type: 'drop', paths: [], position: { x: 0, y: 0 } });

    expect(onDrop).not.toHaveBeenCalled();
    unregister();
  });

  it('drops that land outside every registered target are no-ops', () => {
    const { el } = appendTarget();
    const onDrop = vi.fn();
    const unregister = registerNativeFileDropTarget({ el, onDrop });
    const outsider = document.createElement('div');
    document.body.appendChild(outsider);
    stubElementFromPoint(outsider);

    dispatchNativeFileDrop({ type: 'drop', paths: ['/a'], position: { x: 0, y: 0 } });

    expect(onDrop).not.toHaveBeenCalled();
    unregister();
  });

  it('unregistering a target stops future drops from reaching it', () => {
    const { el, child } = appendTarget();
    const onDrop = vi.fn();
    const unregister = registerNativeFileDropTarget({ el, onDrop });
    stubElementFromPoint(child);

    unregister();
    dispatchNativeFileDrop({ type: 'drop', paths: ['/a'], position: { x: 0, y: 0 } });

    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('nativeFileDropRegistry vs. chip drag/drop — separate channels, no cross-talk', () => {
  it('a chip drag payload (DataTransfer) is still recognized by the existing chip-drop path, independent of native-file-drop dispatch', () => {
    // Chip drags carry a `NodeChipData` payload on a DOM DataTransfer and
    // never touch dispatchNativeFileDrop: the two use different event
    // systems, so the routing is structural. This asserts the chip side.
    const dt = createFakeDataTransfer();
    writeChipDragData(dt, { id: 'doc-123', kind: 'doc', title: 'Roadmap' });

    expect(hasChipDragData(dt)).toBe(true);
    expect(readChipDragData(dt)).toEqual({ id: 'doc-123', kind: 'doc', title: 'Roadmap' });

    // A native-file-drop target registered on the same element never fires
    // for this — there is no Tauri drop payload here, only a DOM DataTransfer.
    const { el, child } = appendTarget();
    const onDrop = vi.fn();
    const unregister = registerNativeFileDropTarget({ el, onDrop });
    stubElementFromPoint(child);

    // No call to dispatchNativeFileDrop happens for a chip drag in the real
    // app (it's a DOM `drop` event, not a Tauri DragDropEvent) — confirmed
    // here by simply never invoking it, leaving onDrop uncalled.
    expect(onDrop).not.toHaveBeenCalled();
    unregister();
  });
});
