/**
 * The autosave engine behind WorkspaceEditor. Dirty is computed by comparing
 * the editor value with a baseline, so programmatic loads (including the
 * onChange TipTap emits on create) never schedule a save. The baseline moves
 * only on a successful save or a new `savedValue`; a new `savedValue` never
 * overwrites a dirty draft.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WorkspaceEditorAutosaveState, WorkspaceEditorSaveResult } from './types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { registerUnloadFlush } from '@desktop/utils/unloadFlush';

interface UseWorkspaceEditorAutosaveOptions {
  /** The currently-persisted value. Updates flow through here only. */
  savedValue: string;
  /** Persist a new value. Optional returned string becomes the new baseline. */
  onSave: (next: string) => Promise<WorkspaceEditorSaveResult> | WorkspaceEditorSaveResult;
  /** Debounce window in ms. */
  delayMs?: number;
  /** Beat to keep "Saved" visible before fading back to pristine. */
  savedFadeMs?: number;
}

interface UseWorkspaceEditorAutosaveResult {
  /** Current editor value (uncommitted). Feeds the editor's `value` prop. */
  value: string;
  /** State machine for the inline indicator. `'pristine'` on mount. */
  state: WorkspaceEditorAutosaveState;
  /** Last error message — null unless state is `'error'`. */
  error: string | null;
  /** Wire to the editor's `onChange`. Compares against the baseline. */
  onChange: (next: string) => void;
  /** Cancel debounce, drain queued edits, and return the canonical saved value. */
  flush: () => Promise<string>;
}

export function useWorkspaceEditorAutosave({
  savedValue,
  onSave,
  delayMs = 600,
  savedFadeMs = 1600,
}: UseWorkspaceEditorAutosaveOptions): UseWorkspaceEditorAutosaveResult {
  const [value, setValue] = useState(savedValue);
  // Always starts pristine: mounting never shows a save state.
  const [state, setState] = useState<WorkspaceEditorAutosaveState>('pristine');
  const [error, setError] = useState<string | null>(null);

  // What diffs are computed against. Changes only on a successful save or a
  // new savedValue, never from editor onChange.
  const baselineRef = useRef(savedValue);
  // Mirror of `value` so async callbacks read the latest without
  // closing over the rendered state.
  const valueRef = useRef(value);
  valueRef.current = value;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  // The value the running drain is saving right now, if any.
  const savingValueRef = useRef<string | null>(null);
  // A single shared drain promise serializes saves. Callers of flush join
  // this promise, including when a save is already in flight, so actions
  // such as Snapshot cannot race ahead of a queued edit.
  const drainPromiseRef = useRef<Promise<string> | null>(null);
  // Latest onSave — wrapped in a ref so the callbacks below don't
  // re-bind on every parent render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Adopt external value updates without queueing a save. A clean editor
  // takes the new value; a dirty one keeps its draft and only moves the
  // baseline. While a save is in flight its drain owns the indicator: our own
  // socket echo can land before the HTTP response, and resetting to
  // 'pristine' then would flash saving → blank → saved.
  useEffect(() => {
    if (savedValue === baselineRef.current) return;
    const hasLocalDraft = valueRef.current !== baselineRef.current;
    baselineRef.current = savedValue;
    const settleIndicator = !inFlightRef.current;
    if (!hasLocalDraft) {
      valueRef.current = savedValue;
      setValue(savedValue);
      if (settleIndicator) {
        setState('pristine');
        setError(null);
      }
    } else {
      // The incoming value matches the draft (e.g. a socket patch with the
      // same edits), so there is nothing left to save.
      if (valueRef.current === savedValue && settleIndicator) {
        setState('pristine');
        setError(null);
      }
    }
  }, [savedValue]);

  const runSave = useCallback((): Promise<string> => {
    if (drainPromiseRef.current) return drainPromiseRef.current;

    const drain = (async (): Promise<string> => {
      inFlightRef.current = true;
      try {
        // A user edit may land while onSave awaits. Loop until the current
        // draft and persisted baseline converge; this is the queue.
        while (valueRef.current !== baselineRef.current) {
          const pending = valueRef.current;
          savingValueRef.current = pending;
          setState('saving');
          setError(null);
          try {
            const result = await onSaveRef.current(pending);
            const canonical = typeof result === 'string' ? result : pending;
            baselineRef.current = canonical;

            // If no newer edit arrived during this request, adopt server
            // canonicalization in the visible draft as well. If a newer edit
            // exists, leave it untouched and the loop persists it next.
            if (valueRef.current === pending) {
              valueRef.current = canonical;
              setValue(canonical);
            }
            setState('saved');
          } catch (err) {
            setError(getErrorMessage(err, 'Save failed'));
            setState('error');
            throw err;
          }
        }
        return baselineRef.current;
      } finally {
        inFlightRef.current = false;
        savingValueRef.current = null;
      }
    })();

    drainPromiseRef.current = drain;
    void drain.then(
      () => {
        if (drainPromiseRef.current === drain) drainPromiseRef.current = null;
      },
      () => {
        if (drainPromiseRef.current === drain) drainPromiseRef.current = null;
      }
    );
    return drain;
  }, []);

  const onChange = useCallback(
    (next: string) => {
      setValue(next);
      // A value equal to the baseline is either a programmatic sync or the
      // user typing back to the saved text. Nothing to save, and a pending
      // debounce must not fire.
      if (next === baselineRef.current) {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        setState((prev) => (prev === 'saving' ? prev : 'pristine'));
        return;
      }
      // Real diff → schedule a save. Skip the state flip while a save
      // is in-flight (it'll re-fire from the finally-block).
      setState((prev) => (prev === 'saving' ? prev : 'dirty'));
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void runSave().catch((err: unknown) => {
          console.error('workspace-editor: debounced save failed', err);
        });
      }, delayMs);
    },
    [delayMs, runSave]
  );

  const flush = useCallback(async (): Promise<string> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (drainPromiseRef.current) return drainPromiseRef.current;
    if (valueRef.current === baselineRef.current) return baselineRef.current;
    return runSave();
  }, [runSave]);

  // After a successful save, fade the indicator back to pristine so it
  // doesn't sit there indefinitely.
  useEffect(() => {
    if (state !== 'saved') return;
    const t = setTimeout(() => setState('pristine'), savedFadeMs);
    return () => clearTimeout(t);
  }, [state, savedFadeMs]);

  // Reload or window close: the debounce will never fire, so write the
  // current draft now, unless the running save already carries it. Like the
  // unmount flush below, this skips the state machine: the page is going.
  useEffect(
    () =>
      registerUnloadFlush(() => {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        const draft = valueRef.current;
        if (draft === baselineRef.current || draft === savingValueRef.current) return;
        return onSaveRef.current(draft);
      }),
    []
  );

  // Unmount flush. Host panels are keyed by entity id, so unmount means the
  // editor is leaving its entity and a pending edit would be lost. Write it
  // fire-and-forget, skipping the state machine. An active drain picks up the
  // latest value itself; if that drain fails, the edit gets one final attempt
  // here once it settles.
  useEffect(() => {
    const saveLatest = () => {
      if (valueRef.current === baselineRef.current) return;
      Promise.resolve(onSaveRef.current(valueRef.current)).catch((err: unknown) => {
        console.error('workspace-editor: unmount flush failed', err);
      });
    };
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (valueRef.current === baselineRef.current) return;
      if (inFlightRef.current) {
        drainPromiseRef.current?.catch(saveLatest);
        return;
      }
      saveLatest();
    };
  }, []);

  return { value, state, error, onChange, flush };
}
