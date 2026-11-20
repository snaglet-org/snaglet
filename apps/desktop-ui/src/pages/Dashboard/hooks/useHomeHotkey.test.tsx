/**
 * ⌘⇧H opens Home in the active pane while `hub_home` is on, as a normal visit
 * Back returns from; with the flag off, or while typing, it does nothing.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const flags = vi.hoisted(() => ({ hub: false }));
vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: (name: string) => (name === 'hub_home' ? flags.hub : false),
  useFeatureFlagsSettled: () => true,
}));

// Restored doc panes hydrate from the tree; an empty tree keeps them id-only.
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, containersApi: { ...actual.containersApi, listTree: async () => [] } };
});

import { useDashboardLayout } from './useDashboardLayout';
import { useHomeHotkey } from './useHomeHotkey';
import { findLeaf } from '../layout/paneTree';
import { LAYOUT_STORAGE_KEY, LAYOUT_STORAGE_VERSION } from '../persistence';

const DOC = { kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' } as const;
const LEAF_ID = 'leaf-restored';

function storeDocPane() {
  window.localStorage.setItem(
    LAYOUT_STORAGE_KEY,
    JSON.stringify({
      version: LAYOUT_STORAGE_VERSION,
      layout: { kind: 'leaf', id: LEAF_ID, selection: DOC, history: { entries: [DOC], index: 0 } },
      activeLeafId: LEAF_ID,
    })
  );
}

function renderDashboard() {
  return renderHook(() => {
    const dashboard = useDashboardLayout();
    useHomeHotkey(dashboard.openHub);
    return dashboard;
  });
}

function pressHome(target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'H',
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  flags.hub = false;
  window.localStorage.clear();
  storeDocPane();
});

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('useHomeHotkey', () => {
  it('opens Home in the active pane, and Back returns to where you were', () => {
    flags.hub = true;
    const { result } = renderDashboard();

    expect(pressHome().defaultPrevented).toBe(true);

    const leaf = findLeaf(result.current.layout, LEAF_ID);
    expect(leaf?.selection).toEqual({ kind: 'hub' });
    expect(leaf?.history.entries).toEqual([DOC, { kind: 'hub' }]);

    act(() => result.current.callbacks.onGoBackInLeaf(LEAF_ID));
    expect(findLeaf(result.current.layout, LEAF_ID)?.selection).toEqual(DOC);
  });

  it('does nothing while hub_home is off', () => {
    const { result } = renderDashboard();

    expect(pressHome().defaultPrevented).toBe(false);
    expect(findLeaf(result.current.layout, LEAF_ID)?.selection).toEqual(DOC);
  });

  it('is ignored while typing in a text field', () => {
    flags.hub = true;
    const { result } = renderDashboard();
    const field = document.body.appendChild(document.createElement('textarea'));

    expect(pressHome(field).defaultPrevented).toBe(false);
    expect(findLeaf(result.current.layout, LEAF_ID)?.selection).toEqual(DOC);
  });
});
