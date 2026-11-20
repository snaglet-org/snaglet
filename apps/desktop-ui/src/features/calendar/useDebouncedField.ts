/**
 * A text field that saves ~400 ms after typing stops and on blur / Enter /
 * close (`flush`). A burst of typing is one logical edit: `onCommit` receives
 * the value from before the burst plus the final value, so the caller can
 * record one undo step per field edit, not one per PATCH.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const TEXT_SAVE_DEBOUNCE_MS = 400;

export interface DebouncedField {
  value: string;
  setValue: (next: string) => void;
  /** Save now if there is a pending change. */
  flush: () => void;
  /** Adopt a new server value when the user isn't mid-edit. */
  reset: (next: string) => void;
}

export function useDebouncedField(
  initial: string,
  onCommit: (next: string, before: string) => void,
  delayMs = TEXT_SAVE_DEBOUNCE_MS
): DebouncedField {
  const [value, setLocal] = useState(initial);
  const valueRef = useRef(initial);
  /** The last saved value; a burst starts from here. */
  const saved = useRef(initial);
  /** The value before the current burst (for one undo step per burst). */
  const burstStart = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = valueRef.current;
    if (next === saved.current) {
      burstStart.current = null;
      return;
    }
    const before = burstStart.current ?? saved.current;
    saved.current = next;
    burstStart.current = null;
    commitRef.current(next, before);
  }, []);

  const setValue = useCallback(
    (next: string) => {
      if (burstStart.current === null) burstStart.current = saved.current;
      valueRef.current = next;
      setLocal(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    },
    [delayMs, flush]
  );

  const reset = useCallback((next: string) => {
    if (timer.current) return; // mid-edit: keep the user's text
    valueRef.current = next;
    saved.current = next;
    setLocal(next);
  }, []);

  // Close / unmount flushes a pending save (Esc closes "flushing a pending save").
  useEffect(() => () => flush(), [flush]);

  return { value, setValue, flush, reset };
}
