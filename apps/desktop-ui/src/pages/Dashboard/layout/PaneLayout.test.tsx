/**
 * Splitting a pane must not remount other panes: an unmounted <PaneChrome>
 * runs its teardown (a live voice call stops with voice:session:stop).
 *
 * PaneChrome is replaced with a mount-count probe, so a pane that survives a
 * split shows mounts === 1 and zero unmounts. This is the React half of the
 * guarantee; paneTree.test.ts covers the data half (reference identity).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createLeaf, repairPaneLayout, splitLeaf, type LayoutNode } from './paneTree';
import { PaneLayout, type PaneCallbacks } from './PaneLayout';

// Shared mount/unmount ledger, keyed by leaf id. Hoisted so the vi.mock factory
// (itself hoisted above imports) can close over it.
const probe = vi.hoisted(() => ({
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
  reset() {
    this.mounts.clear();
    this.unmounts.clear();
  },
}));

// Replace the heavy real PaneChrome (DetailRouter, WS, api, …) with a light
// probe. These tests cover PaneLayout's reconciliation, not PaneChrome's body.
vi.mock('../chrome/PaneChrome/PaneChrome.js', async () => {
  const React = await import('react');
  return {
    PaneChrome: ({ leaf }: { leaf: { id: string } }) => {
      const id = leaf.id;
      React.useEffect(() => {
        probe.mounts.set(id, (probe.mounts.get(id) ?? 0) + 1);
        return () => {
          probe.unmounts.set(id, (probe.unmounts.get(id) ?? 0) + 1);
        };
        // Mount-count probe: [] deps → the effect runs once per real mount and
        // its cleanup once per real unmount. A re-render (same instance) is a
        // no-op here, which is exactly the signal we want.
      }, []);
      return React.createElement('div', { 'data-testid': `pane-${id}` });
    },
  };
});

// react-resizable-panels registers a ResizeObserver on its Group element;
// jsdom has none. A no-op stub lets the Group mount without measuring.
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  probe.reset();
});

const noopCallbacks: PaneCallbacks = {
  onSelectLeaf: () => {},
  onCloseLeaf: () => {},
  onSplit: () => {},
  onReplace: () => {},
  onResize: () => {},
  onGoBackInLeaf: () => {},
  onGoForwardInLeaf: () => {},
  onJumpToHistoryEntry: () => {},
};

function renderLayout(layout: LayoutNode) {
  return render(
    <PaneLayout
      layout={layout}
      activeLeafId={layout.kind === 'leaf' ? layout.id : null}
      callbacks={noopCallbacks}
    />
  );
}

describe('PaneLayout split marker', () => {
  it('marks the root group as split only when there are 2+ panes', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'A' });
    const { container, rerender } = renderLayout(root);
    expect(container.querySelector('[data-group]')?.getAttribute('data-pane-split')).toBeNull();

    const split = splitLeaf(root, root.id, 'right', { kind: 'providers' });
    rerender(<PaneLayout layout={split} activeLeafId={root.id} callbacks={noopCallbacks} />);
    expect(container.querySelector('[data-group]')?.getAttribute('data-pane-split')).toBe('true');
  });
});

describe('PaneLayout reconciliation', () => {
  it('splitting a lone pane keeps the original pane mounted (voice survives)', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'A' });
    const { container, rerender } = renderLayout(root);
    const groupBeforeSplit = container.querySelector('[data-group]');
    const groupIdBeforeSplit = groupBeforeSplit?.id;

    // The lone pane mounted exactly once.
    expect(probe.mounts.get(root.id)).toBe(1);

    // Split it: the original leaf stays, a new sibling pane appears beside it.
    const split = splitLeaf(root, root.id, 'right', { kind: 'providers' });
    rerender(<PaneLayout layout={split} activeLeafId={root.id} callbacks={noopCallbacks} />);

    // The existing pane's instance is not torn down: still 1 mount, 0
    // unmounts.
    expect(probe.mounts.get(root.id)).toBe(1);
    expect(probe.unmounts.get(root.id) ?? 0).toBe(0);
    expect(container.querySelector('[data-group]')).toBe(groupBeforeSplit);
    expect(container.querySelector('[data-group]')?.id).not.toBe(groupIdBeforeSplit);

    // And the new sibling mounted.
    if (split.kind !== 'split') throw new Error('expected split');
    const newLeafId = split.children.find((c) => c.id !== root.id)!.id;
    expect(probe.mounts.get(newLeafId)).toBe(1);
  });

  it('splitting one pane does not remount the untouched sibling', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'A' });
    const split = splitLeaf(root, root.id, 'right', { kind: 'thread', thread_id: 'B' });
    if (split.kind !== 'split') throw new Error('expected split');
    const paneA = split.children[0];
    const paneB = split.children[1];

    const { rerender } = renderLayout(split);
    expect(probe.mounts.get(paneA.id)).toBe(1);
    expect(probe.mounts.get(paneB.id)).toBe(1);

    // Split B (a different pane). A must not be touched at all.
    const next = splitLeaf(split, paneB.id, 'bottom', { kind: 'providers' });
    rerender(<PaneLayout layout={next} activeLeafId={paneA.id} callbacks={noopCallbacks} />);

    // Untouched sibling A: never remounted, never unmounted.
    expect(probe.mounts.get(paneA.id)).toBe(1);
    expect(probe.unmounts.get(paneA.id) ?? 0).toBe(0);
  });

  it('splitting the pane that itself becomes a split remounts only that pane (accepted limit)', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'A' });
    const split = splitLeaf(root, root.id, 'right', { kind: 'thread', thread_id: 'B' });
    if (split.kind !== 'split') throw new Error('expected split');
    const paneA = split.children[0];
    const paneB = split.children[1];

    const { rerender } = renderLayout(split);

    // Split B: B's Panel content goes leaf→split and splitLeaf re-keys it, so B
    // remounts (a known limitation), but A next to it stays put.
    const next = splitLeaf(split, paneB.id, 'bottom', { kind: 'providers' });
    rerender(<PaneLayout layout={next} activeLeafId={paneA.id} callbacks={noopCallbacks} />);

    expect(probe.unmounts.get(paneB.id) ?? 0).toBe(1); // B was torn down …
    expect(probe.mounts.get(paneB.id)).toBe(2); // … and re-created once.
    expect(probe.mounts.get(paneA.id)).toBe(1); // A untouched.
  });

  it('derives a safe one-panel render tree from malformed ratios without mutating the prop', () => {
    const leaf = createLeaf({ kind: 'thread', thread_id: 'A' });
    const malformed: LayoutNode = {
      kind: 'split',
      id: 'stale-one-panel-split',
      direction: 'horizontal',
      children: [leaf],
      ratios: [23.347, 76.653],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => renderLayout(malformed)).not.toThrow();

    expect(probe.mounts.get(leaf.id)).toBe(1);
    expect(malformed.ratios).toEqual([23.347, 76.653]);
    expect(warn).toHaveBeenCalledWith(
      '[pane-layout] repaired invalid layout',
      expect.objectContaining({ source: 'render' })
    );
    warn.mockRestore();
  });

  it('renders an evenly degraded cohort when the 10% minimum is impossible', () => {
    const children = Array.from({ length: 11 }, (_, index) => ({
      ...createLeaf({ kind: 'thread', thread_id: `thread-${index}` }),
      id: `many-pane-${index}`,
    }));
    const repaired = repairPaneLayout({
      kind: 'split',
      id: 'many-pane-split',
      direction: 'horizontal',
      children,
      ratios: [90, ...Array.from({ length: 10 }, () => 1)],
    }).layout;

    expect(() => renderLayout(repaired)).not.toThrow();
    expect(probe.mounts.size).toBe(11);
  });
});
