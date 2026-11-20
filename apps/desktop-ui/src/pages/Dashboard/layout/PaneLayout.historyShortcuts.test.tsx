/**
 * Each split keeps its own history, and the history keys act only on the
 * focused (active) split: ⌘[ steps that pane back, ⌘Y lists that pane's
 * places, and after ⌃Tab moves focus the same keys act on the other pane.
 * Runs the real layout state, PaneLayout and PaneChrome; only the pane bodies
 * and breadcrumbs are stubbed.
 */
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: () => false,
  useFeatureFlagsSettled: () => true,
}));
vi.mock('../views/DetailRouter.js', () => ({ DetailRouter: () => <div>pane body</div> }));
vi.mock('../chrome/PathHeader/PathHeader.js', () => ({ PathHeader: () => null }));
vi.mock('../chrome/PathHeader/useNodeAncestors.js', () => ({ useNodeAncestors: () => [] }));

import { useDashboardLayout } from '../hooks/useDashboardLayout';
import { LAYOUT_STORAGE_KEY, LAYOUT_STORAGE_VERSION } from '../persistence';
import { PaneLayout } from './PaneLayout';
import { findLeaf } from './paneTree';

// Pane A shows Storage (after Providers); pane B shows Browser (after Theme).
const PANE_A = 'leaf-a';
const PANE_B = 'leaf-b';

function storeTwoSplits() {
  const leaf = (id: string, first: string, second: string) => ({
    kind: 'leaf',
    id,
    selection: { kind: second },
    history: { entries: [{ kind: first }, { kind: second }], index: 1 },
  });
  window.localStorage.setItem(
    LAYOUT_STORAGE_KEY,
    JSON.stringify({
      version: LAYOUT_STORAGE_VERSION,
      layout: {
        kind: 'split',
        id: 'split-1',
        direction: 'horizontal',
        ratios: [50, 50],
        children: [leaf(PANE_A, 'providers', 'storage'), leaf(PANE_B, 'theme', 'browser')],
      },
      activeLeafId: PANE_A,
    })
  );
}

const dashboard: { current: ReturnType<typeof useDashboardLayout> | null } = { current: null };

function Harness() {
  const state = useDashboardLayout();
  dashboard.current = state;
  return (
    <PaneLayout
      layout={state.layout}
      activeLeafId={state.activeLeafId}
      callbacks={state.callbacks}
    />
  );
}

function shown(leafId: string): string | undefined {
  const layout = dashboard.current?.layout;
  return layout ? findLeaf(layout, leafId)?.selection?.kind : undefined;
}

function press(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    );
  });
}

const BACK = { key: '[', metaKey: true };
const HISTORY = { key: 'y', metaKey: true };
const NEXT_PANE = { key: 'Tab', ctrlKey: true };

function menuLabels(): string[] {
  const menu = screen.getByRole('menu', { name: 'Recently visited' });
  return within(menu)
    .getAllByRole('menuitem')
    .map((row) => row.querySelector('[data-row-label]')?.textContent ?? '');
}

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

beforeEach(() => {
  window.localStorage.clear();
  storeTwoSplits();
  render(<Harness />);
});

afterEach(() => {
  window.localStorage.clear();
  dashboard.current = null;
});

describe('history shortcuts in a split layout', () => {
  it('steps back only the focused pane', () => {
    press(BACK);
    expect(shown(PANE_A)).toBe('providers');
    expect(shown(PANE_B)).toBe('browser');
  });

  it('lists only the focused pane’s places in Recently visited', () => {
    press(HISTORY);
    expect(menuLabels()).toEqual(['Local storage', 'Providers']);
  });

  it('acts on the other pane’s history once focus moves there', () => {
    press(NEXT_PANE);
    expect(dashboard.current?.activeLeafId).toBe(PANE_B);

    press(BACK);
    expect(shown(PANE_B)).toBe('theme');
    expect(shown(PANE_A)).toBe('storage');

    // Browser is now forward of Theme, so it sits above it.
    press(HISTORY);
    expect(menuLabels()).toEqual(['Browser', 'Theme']);
    expect(screen.getByRole('menuitem', { current: 'page' })).toHaveTextContent('Theme');
  });

  it('marks the focused pane, the one the keys act on', () => {
    const paneA = document.querySelector<HTMLElement>(`[data-leaf-id="${PANE_A}"]`);
    const paneB = document.querySelector<HTMLElement>(`[data-leaf-id="${PANE_B}"]`);
    expect(paneA).toHaveAttribute('data-pane-focused', 'true');
    expect(paneB).not.toHaveAttribute('data-pane-focused');

    press(NEXT_PANE);
    expect(paneB).toHaveAttribute('data-pane-focused', 'true');
    expect(paneA).not.toHaveAttribute('data-pane-focused');
  });
});
