import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { createStatusBarStore, type StatusBarStore } from './statusBarStore';
import type { StatusBarSlot } from './types';

/**
 * Status bar context — the single registry every consumer talks to. Created
 * once per <StatusBarProvider>; the store instance is stable for the app's
 * lifetime, so hooks that depend on it never churn.
 */
const StatusBarContext = createContext<StatusBarStore | null>(null);

export function StatusBarProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<StatusBarStore | null>(null);
  if (storeRef.current === null) storeRef.current = createStatusBarStore();
  return <StatusBarContext.Provider value={storeRef.current}>{children}</StatusBarContext.Provider>;
}

export function useStatusBarStore(): StatusBarStore {
  const store = useContext(StatusBarContext);
  if (!store) {
    throw new Error('useStatusBar* must be used within <StatusBarProvider>');
  }
  return store;
}

/**
 * Imperative registry access — register/unregister slots outside of render
 * (e.g. push an ephemeral alert from an event handler). The returned object is
 * stable.
 */
export function useStatusBar(): {
  register: (slot: StatusBarSlot) => void;
  unregister: (id: string) => void;
} {
  const store = useStatusBarStore();
  return useMemo(
    () => ({
      register: (slot: StatusBarSlot) => store.register(slot),
      unregister: (id: string) => store.unregister(id),
    }),
    [store]
  );
}

/**
 * Declarative slot registration — the primary consumer API.
 *
 * Registers `slot` on mount / whenever it changes, and unregisters on unmount.
 * Pass `null` to register nothing (for conditionally-shown slots).
 *
 * MEMOIZE the slot (`useMemo`) keyed on the values that actually change so the
 * effect only re-runs (and the bar only re-renders) when the content changes.
 *
 * @example
 * const slot = useMemo<StatusBarSlot>(() => ({
 *   id: 'my-feature',
 *   zone: 'left',
 *   item: { type: 'text', label: status },
 * }), [status]);
 * useStatusBarSlot(slot);
 */
export function useStatusBarSlot(slot: StatusBarSlot | null): void {
  const store = useStatusBarStore();
  useEffect(() => {
    if (!slot) return;
    store.register(slot);
    return () => store.unregister(slot.id);
  }, [store, slot]);
}
