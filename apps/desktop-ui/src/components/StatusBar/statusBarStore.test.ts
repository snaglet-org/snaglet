import { describe, expect, it, vi } from 'vitest';
import { createStatusBarStore } from './statusBarStore';
import type { StatusBarSlot } from './types';

const text = (id: string, order?: number, label = id): StatusBarSlot => ({
  id,
  zone: 'left',
  order,
  item: { type: 'text', label },
});

describe('statusBarStore', () => {
  it('registers and exposes slots via the snapshot', () => {
    const store = createStatusBarStore();
    store.register(text('a'));
    expect(store.getSnapshot().map((s) => s.id)).toEqual(['a']);
  });

  it('replaces a slot registered under the same id (no duplicates)', () => {
    const store = createStatusBarStore();
    store.register(text('a', 0, 'first'));
    store.register(text('a', 0, 'second'));
    const snap = store.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].item).toMatchObject({ label: 'second' });
  });

  it('unregisters a slot; unregistering an absent id is a no-op', () => {
    const store = createStatusBarStore();
    store.register(text('a'));
    store.unregister('a');
    expect(store.getSnapshot()).toHaveLength(0);
    expect(() => store.unregister('missing')).not.toThrow();
  });

  it('orders by `order` ascending, then registration order for ties', () => {
    const store = createStatusBarStore();
    store.register(text('late', 10));
    store.register(text('early', 1));
    store.register(text('tieB', 5));
    store.register(text('tieA', 5));
    expect(store.getSnapshot().map((s) => s.id)).toEqual(['early', 'tieB', 'tieA', 'late']);
  });

  it('returns a stable snapshot reference until a mutation occurs', () => {
    const store = createStatusBarStore();
    store.register(text('a'));
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first); // no mutation → same ref
    store.register(text('b'));
    expect(store.getSnapshot()).not.toBe(first); // mutation → new ref
  });

  it('notifies subscribers on register / unregister', () => {
    const store = createStatusBarStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.register(text('a'));
    store.unregister('a');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.register(text('b'));
    expect(listener).toHaveBeenCalledTimes(2); // not notified after unsubscribe
  });

  it('serves the latest slot object when a re-registration changes nothing visible', () => {
    const store = createStatusBarStore();
    store.register(text('a', 0, 'same'));
    const listener = vi.fn();
    store.subscribe(listener);
    // Same visible fields, brand-new object carrying fresh closures.
    const fresh = text('a', 0, 'same');
    store.register(fresh);
    expect(store.getSnapshot()).toEqual([fresh]);
    expect(store.getSnapshot()[0]).toBe(fresh);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps a replaced slot in its registration place among equal orders', () => {
    const store = createStatusBarStore();
    store.register(text('a'));
    store.register(text('b'));
    store.register(text('a', 0, 'again'));
    expect(store.getSnapshot().map((slot) => slot.id)).toEqual(['a', 'b']);
  });
});
