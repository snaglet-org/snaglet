import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidebarViewId } from '../sidebar';

// useSidebarReveal: coordinates "reveal this item in a sidebar view" requests
// from outside the sidebar (breadcrumbs, deep links, cross-view search). The
// target view reads `revealNodeId` + `revealNonce` (the nonce re-fires a
// repeated id). `requestReveal(id, targetView)` routes to the owning view; if
// the sidebar is closed or on another view, the request waits in a ref and
// replays once the sidebar is open on that view.

export interface UseSidebarRevealArgs {
  sidebarOpen: boolean;
  sidebarView: SidebarViewId;
  setSidebarOpen: (open: boolean) => void;
  setSidebarView: (view: SidebarViewId) => void;
}

export interface UseSidebarRevealResult {
  /** Id the target view should expand/scroll to. */
  pendingRevealId: string | null;
  /** Which view the pending reveal belongs to. */
  revealTargetView: SidebarViewId;
  /** Bump to re-fire the reveal effect for the same id. */
  revealNonce: number;
  /**
   * Reveal `id` in `targetView` (default: the library tree). Switches the
   * sidebar to that view first and replays once it has mounted.
   */
  requestReveal: (id: string, targetView?: SidebarViewId) => void;
}

interface DeferredReveal {
  id: string;
  view: SidebarViewId;
}

export function useSidebarReveal({
  sidebarOpen,
  sidebarView,
  setSidebarOpen,
  setSidebarView,
}: UseSidebarRevealArgs): UseSidebarRevealResult {
  const [pendingRevealId, setPendingRevealId] = useState<string | null>(null);
  const [revealTargetView, setRevealTargetView] = useState<SidebarViewId>('library');
  const [revealNonce, setRevealNonce] = useState(0);
  const deferredRevealRef = useRef<DeferredReveal | null>(null);

  // One tick of grace via setTimeout(…, 0): once the sidebar mounts +
  // renders the target view's rows we ask it to expand/scroll. The replay
  // only fires when the sidebar is open and showing the view the deferred
  // reveal was requested for — so a tools reveal never fires against the
  // library tree.
  useEffect(() => {
    if (!sidebarOpen) return;
    const pending = deferredRevealRef.current;
    if (!pending || pending.view !== sidebarView) return;
    deferredRevealRef.current = null;
    const id = window.setTimeout(() => {
      setRevealTargetView(pending.view);
      setPendingRevealId(pending.id);
      setRevealNonce((n) => n + 1);
    }, 0);
    return () => window.clearTimeout(id);
  }, [sidebarOpen, sidebarView]);

  // A reveal belongs to one visit of its view: once the sidebar closes or
  // shows another view, drop it, so the view does not replay it (expanded and
  // pulsing) the next time it mounts. A deferred request is untouched: it is
  // replayed above once the sidebar is back on its view.
  useEffect(() => {
    if (sidebarOpen && sidebarView === revealTargetView) return;
    setPendingRevealId(null);
  }, [sidebarOpen, sidebarView, revealTargetView]);

  const requestReveal = useCallback(
    (id: string, targetView: SidebarViewId = 'library') => {
      // Already on the target view — fire immediately.
      if (sidebarOpen && sidebarView === targetView) {
        setRevealTargetView(targetView);
        setPendingRevealId(id);
        setRevealNonce((n) => n + 1);
        return;
      }
      // Otherwise stash and replay once the sidebar is open on that view.
      deferredRevealRef.current = { id, view: targetView };
      if (!sidebarOpen) setSidebarOpen(true);
      if (sidebarView !== targetView) setSidebarView(targetView);
    },
    [sidebarOpen, sidebarView, setSidebarOpen, setSidebarView]
  );

  return { pendingRevealId, revealTargetView, revealNonce, requestReveal };
}
