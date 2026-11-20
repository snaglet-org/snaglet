// Debounced save-on-change for a host that owns its own value state. Call
// `markChanged(value)` from `onChange`; `flush()` skips the debounce (on blur
// or unmount). A change during an in-flight save is saved right after it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { registerUnloadFlush } from '@desktop/utils/unloadFlush';

type AutosaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface UseAutosaveOptions {
  /** Async persist function. Called with the latest value scheduled. */
  save: (value: string) => Promise<void> | void;
  /** Debounce window in ms. Default 600. */
  delayMs?: number;
  /** After a successful save, how long to keep the 'saved' indicator
   *  before reverting to 'idle'. Defaults to 1600ms. */
  savedFadeMs?: number;
}

interface UseAutosaveResult {
  state: AutosaveState;
  error: string | null;
  /** Call after every change with the new value. Resets the debounce. */
  markChanged: (value: string) => void;
  /** Cancel any pending save timer and fire immediately. */
  flush: () => Promise<void>;
}

export function useAutosave({
  save,
  delayMs = 600,
  savedFadeMs = 1600,
}: UseAutosaveOptions): UseAutosaveResult {
  const [state, setState] = useState<AutosaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValueRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;

  const runSave = useCallback(async () => {
    if (inFlightRef.current) {
      // A save is already running — note that another save is needed
      // and let the in-flight one's finally-block trigger us again.
      queuedRef.current = true;
      return;
    }
    const value = pendingValueRef.current;
    if (value === null) return;
    pendingValueRef.current = null;
    inFlightRef.current = true;
    setState('saving');
    setError(null);
    try {
      await saveRef.current(value);
      setState('saved');
    } catch (err) {
      setError(getErrorMessage(err, 'Save failed'));
      setState('error');
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void runSave();
      }
    }
  }, []);

  const markChanged = useCallback(
    (value: string) => {
      pendingValueRef.current = value;
      setState((prev) => (prev === 'saving' ? prev : 'dirty'));
      setError(null);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void runSave();
      }, delayMs);
    },
    [delayMs, runSave]
  );

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingValueRef.current !== null) {
      await runSave();
    }
  }, [runSave]);

  // After a 'saved' beat, fade back to 'idle' so the indicator doesn't
  // sit there indefinitely.
  useEffect(() => {
    if (state !== 'saved') return;
    const t = setTimeout(() => setState('idle'), savedFadeMs);
    return () => clearTimeout(t);
  }, [state, savedFadeMs]);

  // Reload or window close: the debounce will never fire, so send the
  // unsaved value at once, even past an in-flight save (the unload cancels
  // that one, and this value is newer).
  useEffect(
    () =>
      registerUnloadFlush(() => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const value = pendingValueRef.current;
        if (value === null) return;
        pendingValueRef.current = null;
        queuedRef.current = false;
        return saveRef.current(value);
      }),
    []
  );

  // Cleanup pending timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { state, error, markChanged, flush };
}
