import type { StatusBarSlot } from './types';

/**
 * External store backing the status bar registry.
 *
 * Kept framework-light (a tiny pub/sub) so it can be driven from
 * `useSyncExternalStore` on the render side and from plain effects on the
 * consumer side. Slots are keyed by `id`; the snapshot is a stable, globally
 * ordered array (rebuilt only on mutation) so `useSyncExternalStore` never
 * loops. Re-registering an id replaces the slot, so the bar always renders
 * the latest closures (an `onClick`, a popover's `render`).
 */
export interface StatusBarStore {
  /** Add a slot, or replace the existing slot with the same id. */
  register(slot: StatusBarSlot): void;
  /** Remove a slot by id. No-op if absent. */
  unregister(id: string): void;
  subscribe(listener: () => void): () => void;
  /** Globally ordered snapshot (by `order` asc, then registration order). */
  getSnapshot(): readonly StatusBarSlot[];
}

interface Entry {
  slot: StatusBarSlot;
  /** Registration order, kept when a slot is replaced, to break `order` ties. */
  seq: number;
}

export function createStatusBarStore(): StatusBarStore {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let seqCounter = 0;
  let snapshot: readonly StatusBarSlot[] = [];

  // Every mutation rebuilds the snapshot, so it always holds the freshest
  // slots (and their closures), and notifies.
  const commit = (): void => {
    snapshot = Array.from(entries.values())
      .sort((a, b) => (a.slot.order ?? 0) - (b.slot.order ?? 0) || a.seq - b.seq)
      .map((entry) => entry.slot);
    for (const listener of listeners) listener();
  };

  return {
    register(slot) {
      const existing = entries.get(slot.id);
      entries.set(slot.id, { slot, seq: existing?.seq ?? seqCounter++ });
      commit();
    },
    unregister(id) {
      if (entries.delete(id)) commit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
  };
}
