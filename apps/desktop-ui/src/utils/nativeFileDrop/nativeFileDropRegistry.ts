// nativeFileDropRegistry — route Tauri's native OS file/folder drop event to
// the editable surface under the drop point.
//
// The browser's File API never exposes a dropped file's path. Tauri reports
// paths on a separate window-level event (`onDragDropEvent`) with a
// physical-pixel drop position but no DOM element, so this hit-tests the
// registered targets. In-page chip drags use ordinary HTML5 drag events, so
// the two never collide. The native handler is enabled on Windows and
// disabled on macOS, where it conflicts with in-app chip and pane drags.

interface NativeFileDropTarget {
  /** The DOM element this target owns. A drop is routed here when the
   *  (converted) drop position lands inside this element's subtree. */
  el: HTMLElement;
  /** `pathsText` is the dropped path(s) newline-joined, in drop order.
   *  Folders are included exactly like files — this only ever inserts a
   *  path as text, never reads file/folder content. `clientPos` is the
   *  drop position converted to CSS/logical pixels, for callers (e.g.
   *  ProseMirror's `view.posAtCoords`) that want to resolve a caret. */
  onDrop: (pathsText: string, clientPos: { x: number; y: number }) => void;
}

/** Minimal shape of a Tauri `DragDropEvent` payload — kept independent of
 *  `@tauri-apps/api`'s own `DragDropEvent` type (rather than importing it)
 *  so tests can construct one without a Tauri dependency. The real
 *  `DragDropEvent` union satisfies this structurally. */
interface RawDragDropPayload {
  type: string;
  paths?: string[];
  position?: { x: number; y: number };
}

const targets = new Set<NativeFileDropTarget>();

function findTarget(domEl: Element | null): NativeFileDropTarget | undefined {
  if (!domEl) return undefined;
  for (const target of targets) {
    if (target.el.contains(domEl)) return target;
  }
  return undefined;
}

/**
 * Resolve a raw Tauri drag-drop payload's physical-pixel `position` to the
 * registered target under it and dispatch. Exported for tests; the app
 * dispatches through the Tauri listener below.
 *
 * Note: `position` is relative to the window's top-left, not the webview, so
 * a native title bar can offset Y by its height.
 */
export function dispatchNativeFileDrop(payload: RawDragDropPayload): void {
  if (payload.type !== 'drop') return;
  const { paths, position } = payload;
  if (!paths || paths.length === 0) return;
  const dpr =
    typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  const clientPos = position ? { x: position.x / dpr, y: position.y / dpr } : { x: 0, y: 0 };
  const domEl = document.elementFromPoint(clientPos.x, clientPos.y);
  const target = findTarget(domEl);
  if (!target) return;
  target.onDrop(paths.join('\n'), clientPos);
}

let listening = false;
let starting: Promise<void> | null = null;

async function ensureListening(): Promise<void> {
  if (listening) return;
  if (starting) {
    await starting;
    return;
  }
  starting = (async () => {
    // Only attempt inside an actual Tauri webview — the browser-preview
    // build and vitest (jsdom) never define these globals. Mirrors the
    // `isTauri` check in `src/socket/index.ts`.
    const w = window as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
    if (!w.__TAURI_INTERNALS__ && !w.__TAURI__) return;
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      await getCurrentWebview().onDragDropEvent((event) => {
        dispatchNativeFileDrop(event.payload);
      });
      listening = true;
    } catch {
      // Not running under Tauri, or the native drag-drop handler is
      // disabled on this window (see module doc comment) — no-op.
    }
  })();
  await starting;
  starting = null;
}

/** Register an editable surface as a native-file-drop target. Returns an
 *  unregister function — call it on unmount (or before re-registering a
 *  new element for the same surface). */
export function registerNativeFileDropTarget(target: NativeFileDropTarget): () => void {
  targets.add(target);
  void ensureListening();
  return () => {
    targets.delete(target);
  };
}
