import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { registerUnloadFlush } from '@desktop/utils/unloadFlush';

type DebouncedSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const SAVE_DEBOUNCE_MS = 400;
const SAVED_FADE_MS = 1600;

export interface UseDebouncedSaveResult {
  saveState: DebouncedSaveState;
  /** Exposed so hosts can mark 'dirty' on field edits / reset to 'idle' on rehydrate. */
  setSaveState: Dispatch<SetStateAction<DebouncedSaveState>>;
  queueSave: (mode?: 'debounced' | 'immediate') => void;
  /** Invokes the persist path right now (awaitable) — bypasses the debounce timer. */
  flush: () => Promise<void>;
  /** Drop scheduled work when replacing the draft with authoritative state. */
  cancelPending: () => void;
}

/**
 * Debounced-save state machine for the Dashboard's autosaving panels
 * (DetailsPanel). The host supplies `persist`, which reads its own
 * latest-value refs and throws on failure so the state lands on 'error'.
 * Overlapping saves coalesce, so the last write always ships. 'immediate'
 * still defers one macrotask so the caller's setState renders before
 * `persist` reads the refs. Unmount cancels pending work unless the host opts
 * into a final flush; a reload or window close runs a scheduled or queued
 * save at once.
 */
export function useDebouncedSave(
  persist: () => Promise<void>,
  opts?: { delayMs?: number; savedFadeMs?: number; flushOnUnmount?: boolean }
): UseDebouncedSaveResult {
  const delayMs = opts?.delayMs ?? SAVE_DEBOUNCE_MS;
  const savedFadeMs = opts?.savedFadeMs ?? SAVED_FADE_MS;

  const [saveState, setSaveState] = useState<DebouncedSaveState>('idle');

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const mountedRef = useRef(true);
  const lifecycleRef = useRef(0);
  const flushOnUnmountRef = useRef(opts?.flushOnUnmount ?? false);
  flushOnUnmountRef.current = opts?.flushOnUnmount ?? false;

  // Kept fresh every render so timers call the latest closure (the host's
  // `persist` typically reads latest-value refs, but hosts that recreate it
  // per render still get the newest one here).
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const runPersist = useCallback(async () => {
    if (savingRef.current) {
      queuedRef.current = true;
      return;
    }
    savingRef.current = true;
    const lifecycle = lifecycleRef.current;
    const canUpdate = () => mountedRef.current && lifecycleRef.current === lifecycle;
    if (mountedRef.current) setSaveState('saving');
    try {
      await persistRef.current();
      if (canUpdate()) setSaveState(queuedRef.current || saveTimerRef.current ? 'dirty' : 'saved');
    } catch {
      // The host's `persist` records its own error message before throwing.
      if (canUpdate()) setSaveState('error');
    } finally {
      savingRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void runPersistRef.current();
      }
    }
  }, []);

  const runPersistRef = useRef(runPersist);
  runPersistRef.current = runPersist;

  const flush = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await runPersistRef.current();
  }, []);

  const cancelPending = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    queuedRef.current = false;
  }, []);

  const queueSave = useCallback(
    (mode: 'debounced' | 'immediate' = 'debounced') => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // Immediate mode still defers to the next macrotask so any pending
      // setState (e.g. the caller did `setThreadId(next);
      // queueSave('immediate')`) commits and the next render runs first —
      // which updates the refs the persist function reads. Without this
      // defer, persist sees the pre-setState values via stale refs.
      setSaveState((prev) => (prev === 'saving' ? prev : 'dirty'));
      saveTimerRef.current = setTimeout(
        () => {
          saveTimerRef.current = null;
          void runPersistRef.current();
        },
        mode === 'immediate' ? 0 : delayMs
      );
    },
    [delayMs]
  );

  // Fade "Saved" back to idle.
  useEffect(() => {
    if (saveState !== 'saved') return;
    const id = setTimeout(() => setSaveState('idle'), savedFadeMs);
    return () => clearTimeout(id);
  }, [saveState, savedFadeMs]);

  useEffect(
    () =>
      registerUnloadFlush(() => {
        const scheduled = saveTimerRef.current !== null || queuedRef.current;
        if (!scheduled) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        queuedRef.current = false;
        return persistRef.current();
      }),
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    lifecycleRef.current += 1;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      if (flushOnUnmountRef.current) void runPersistRef.current();
    };
  }, []);

  return { saveState, setSaveState, queueSave, flush, cancelPending };
}
