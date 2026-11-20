import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface PaneFindContextValue {
  isActive: boolean;
  /** True for a provider that lives inside a dialog (a preview modal). */
  inDialog: boolean;
  register: (open: () => void) => () => void;
  /** Queries the pane's own searches keep while the pane stays open, by key. */
  memory: Map<string, string>;
}

const PaneFindContext = createContext<PaneFindContextValue | null>(null);

/**
 * One shortcut owner per leaf; uses the existing pane activation state. A
 * preview modal mounts its own with `inDialog`, so Cmd/Ctrl+F searches the
 * previewed doc or thread: a pane's provider stands down while any dialog is
 * open, and the dialog's own provider answers instead.
 */
export function PaneFindProvider({
  isActive,
  inDialog = false,
  children,
}: {
  isActive: boolean;
  inDialog?: boolean;
  children: ReactNode;
}) {
  const handler = useRef<(() => void) | null>(null);
  const [memory] = useState(() => new Map<string, string>());
  const register = useCallback((open: () => void) => {
    handler.current = open;
    return () => {
      if (handler.current === open) handler.current = null;
    };
  }, []);
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'f')
        return;
      // Native browser find never takes ownership of a workspace pane.
      event.preventDefault();
      event.stopPropagation();
      if (inDialog || !document.querySelector('[role="dialog"]')) handler.current?.();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isActive, inDialog]);
  const value = useMemo(
    () => ({ isActive, inDialog, register, memory }),
    [isActive, inDialog, register, memory]
  );
  return <PaneFindContext.Provider value={value}>{children}</PaneFindContext.Provider>;
}

/**
 * Whether the view's pane is the active one, for pane-scoped shortcuts
 * (e.g. a table's Cmd/Ctrl+Z); false outside a pane.
 */
export function usePaneIsActive(): boolean {
  return useContext(PaneFindContext)?.isActive ?? false;
}

/**
 * Give the pane's Cmd/Ctrl+F to a view's own search instead of a find bar,
 * e.g. a paged table whose search reaches rows on every page.
 */
export function usePaneFindShortcut(onFind: () => void, enabled = true): void {
  const context = useContext(PaneFindContext);
  const latest = useRef(onFind);
  latest.current = onFind;
  useEffect(() => {
    if (!context || !enabled) return;
    return context.register(() => latest.current());
  }, [context, enabled]);
}

/**
 * A search query this pane remembers under `key` while it stays open, so a
 * view shown again in the pane restores it; empty outside a pane.
 */
export function usePaneFindMemory(key: string): [string, (query: string) => void] {
  const memory = useContext(PaneFindContext)?.memory;
  const remember = useCallback(
    (query: string) => {
      if (!memory) return;
      if (query) memory.set(key, query);
      else memory.delete(key);
    },
    [memory, key]
  );
  return [memory?.get(key) ?? '', remember];
}

export function usePaneFindSession(enabled = true, identity?: string) {
  const context = useContext(PaneFindContext);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [index, setIndex] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const previousFocus = useRef<HTMLElement | null>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(false);
  const close = useCallback((restore = true) => {
    openRef.current = false;
    setOpen(false);
    if (restore && previousFocus.current?.isConnected)
      previousFocus.current.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!context || !enabled) return;
    return context.register(() => {
      if (!openRef.current)
        previousFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      openRef.current = true;
      setOpen(true);
      setFocusRequest((value) => value + 1);
    });
  }, [context, enabled]);
  useEffect(() => {
    if (open) {
      queryRef.current?.focus();
      queryRef.current?.select();
    }
  }, [open, focusRequest]);
  useEffect(() => {
    if (!context?.isActive || !enabled) close(false);
  }, [context?.isActive, enabled, close]);
  useEffect(() => {
    close(false);
    setQuery('');
    setIndex(0);
  }, [identity, close]);
  useEffect(() => {
    setIndex(0);
  }, [query, caseSensitive]);
  useEffect(() => {
    if (!open || !context?.isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A pane's find bar leaves Escape to an open dialog; a find bar inside
      // the dialog closes first, and the next Escape closes the dialog.
      if (!context.inDialog && document.querySelector('[role="dialog"]')) return;
      // Only an Escape aimed at the find bar closes it. With focus elsewhere
      // (the editor's own popovers, the sidebar, another pane) the key
      // belongs to that surface and must reach it.
      const bar = queryRef.current?.closest('[role="search"]');
      const target = event.target instanceof Node ? event.target : null;
      const aimedAtBar =
        !!bar && (bar.contains(document.activeElement) || (!!target && bar.contains(target)));
      if (!aimedAtBar) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, context?.isActive, context?.inDialog, close]);
  return {
    open: open && !!context?.isActive && enabled,
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    index,
    setIndex,
    queryRef,
    close,
  };
}

export type PaneFindSession = ReturnType<typeof usePaneFindSession>;
