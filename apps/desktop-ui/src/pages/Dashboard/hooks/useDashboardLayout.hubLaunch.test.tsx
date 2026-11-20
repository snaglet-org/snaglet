/**
 * What a window opens with under the `hub_home` flag: Home fills a window
 * with nothing to restore, a saved layout stays as it was, the decision waits
 * for the flags to load and is made once, and with the flag off nothing
 * changes.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const flags = vi.hoisted(() => ({ hub: false, settled: false }));
vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: (name: string) => (name === 'hub_home' ? flags.hub : false),
  useFeatureFlagsSettled: () => flags.settled,
}));

// Restored doc panes hydrate from the tree; an empty tree keeps them id-only.
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, containersApi: { ...actual.containersApi, listTree: async () => [] } };
});

import { useDashboardLayout } from './useDashboardLayout';
import { findLeaf, leafIds } from '../layout/paneTree';
import { LAYOUT_STORAGE_KEY, LAYOUT_STORAGE_VERSION } from '../persistence';

const docSelection = { kind: 'doc', doc_id: 'doc-1' } as const;
/** The per-device "Open Home on launch" key earlier prototypes stored. */
const RETIRED_LAUNCH_KEY = 'snaglet.hub.openOnLaunch';

function storeLayout(selection: typeof docSelection | null) {
  const leaf = {
    kind: 'leaf',
    id: 'leaf-restored',
    selection,
    history: selection ? { entries: [selection], index: 0 } : { entries: [], index: -1 },
  };
  window.localStorage.setItem(
    LAYOUT_STORAGE_KEY,
    JSON.stringify({ version: LAYOUT_STORAGE_VERSION, layout: leaf, activeLeafId: 'leaf-restored' })
  );
}

function selections(result: { current: ReturnType<typeof useDashboardLayout> }) {
  const { layout } = result.current;
  return leafIds(layout).map((id) => findLeaf(layout, id)?.selection ?? null);
}

beforeEach(() => {
  flags.hub = false;
  flags.settled = false;
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('useDashboardLayout launch with hub_home', () => {
  it('opens Home in a fresh window once the flags load', () => {
    flags.hub = true;
    const { result, rerender } = renderHook(() => useDashboardLayout());
    // Not before the flags are known.
    expect(selections(result)).toEqual([null]);
    flags.settled = true;
    rerender();
    expect(selections(result)).toEqual([{ kind: 'hub' }]);
    expect(result.current.activeLeafId).toBe(leafIds(result.current.layout)[0]);
  });

  it('leaves a saved layout as it was', () => {
    flags.hub = true;
    flags.settled = true;
    storeLayout(docSelection);
    const { result } = renderHook(() => useDashboardLayout());
    expect(selections(result)).toEqual([docSelection]);
    const leaf = findLeaf(result.current.layout, leafIds(result.current.layout)[0]!);
    expect(leaf?.history.entries).toEqual([docSelection]);
  });

  it('ignores the retired Open Home on launch preference', () => {
    flags.hub = true;
    flags.settled = true;
    storeLayout(docSelection);
    window.localStorage.setItem(RETIRED_LAUNCH_KEY, 'true');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const { result } = renderHook(() => useDashboardLayout());
    expect(selections(result)).toEqual([docSelection]);
    expect(getItem).not.toHaveBeenCalledWith(RETIRED_LAUNCH_KEY);
    getItem.mockRestore();
  });

  it('fills a restored layout whose panes are all empty', () => {
    flags.hub = true;
    flags.settled = true;
    storeLayout(null);
    const { result } = renderHook(() => useDashboardLayout());
    expect(selections(result)).toEqual([{ kind: 'hub' }]);
  });

  it('decides once: a flag turned on later does not move a pane', () => {
    flags.settled = true;
    const { result, rerender } = renderHook(() => useDashboardLayout());
    flags.hub = true;
    rerender();
    expect(selections(result)).toEqual([null]);
  });

  it('changes nothing while the flag is off (the default)', () => {
    flags.settled = true;
    const { result } = renderHook(() => useDashboardLayout());
    expect(selections(result)).toEqual([null]);
  });

  it('opens Home in the active pane on request', () => {
    flags.settled = true;
    storeLayout(docSelection);
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openHub());
    expect(selections(result)).toEqual([{ kind: 'hub' }]);
  });
});
