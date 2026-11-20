import { useCallback, useRef, useState } from 'react';

interface CreateFlow {
  /** Whether the form is open. */
  open: boolean;
  /** Open the form; `onCreated` runs once the item is created, never on cancel. */
  start: (onCreated?: () => void) => void;
  /** The item was created: close the form and run the caller's `onCreated`. */
  finish: () => void;
  /** Close the form without creating anything. */
  cancel: () => void;
}

/**
 * A create form the Dashboard opens for whoever asks (a hotkey, the Get
 * started pane), which tells the caller only when the item was created.
 */
export function useCreateFlow(): CreateFlow {
  const [open, setOpen] = useState(false);
  const onCreatedRef = useRef<(() => void) | null>(null);

  const start = useCallback((onCreated?: () => void) => {
    onCreatedRef.current = onCreated ?? null;
    setOpen(true);
  }, []);
  const finish = useCallback(() => {
    const onCreated = onCreatedRef.current;
    onCreatedRef.current = null;
    setOpen(false);
    onCreated?.();
  }, []);
  const cancel = useCallback(() => {
    onCreatedRef.current = null;
    setOpen(false);
  }, []);

  return { open, start, finish, cancel };
}
