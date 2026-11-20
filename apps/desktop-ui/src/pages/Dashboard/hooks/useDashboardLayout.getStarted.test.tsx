/**
 * What a window opens with on first run: Get started fills a window with
 * nothing to restore when the first-run state says so, beside Home when the
 * `hub_home` flag is on and the window is wide enough; Home alone once the
 * first run is done. A saved layout stays as it was (so a reload never adds a
 * second pane), and a pane the person filled meanwhile is not replaced.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const flags = vi.hoisted(() => ({ hub: false }));
vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: () => flags.hub,
  useFeatureFlagsSettled: () => true,
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, containersApi: { ...actual.containersApi, listTree: async () => [] } };
});

const NEW_INSTALL = { seed: { status: 'done' }, progress: {}, provider: { kind: 'none' } };
const MET_PATTY = {
  seed: { status: 'done' },
  progress: { pattyOpenedAt: '2026-11-16T10:00:00.000Z' },
  provider: { kind: 'ready', providerId: 'anthropic' },
};

const launch = vi.hoisted(() => ({
  onboarding: {} as Record<string, unknown>,
  release: (): void => {},
}));
vi.mock('@desktop/features/onboarding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/features/onboarding')>();
  return {
    ...actual,
    refreshOnboarding: () =>
      new Promise((resolve) => {
        launch.release = () => resolve({ status: 'ready', ...launch.onboarding });
      }),
  };
});

import { useDashboardLayout } from './useDashboardLayout';
import { findLeaf, leafIds } from '../layout/paneTree';
import { LAYOUT_STORAGE_KEY, LAYOUT_STORAGE_VERSION } from '../persistence';

const docSelection = { kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' } as const;

function storeLayout(selection: typeof docSelection) {
  const leaf = {
    kind: 'leaf',
    id: 'leaf-restored',
    selection,
    history: { entries: [selection], index: 0 },
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

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

const initialWidth = window.innerWidth;

beforeEach(() => {
  flags.hub = false;
  launch.onboarding = NEW_INSTALL;
  setWindowWidth(1280);
  window.localStorage.clear();
});

afterEach(() => {
  setWindowWidth(initialWidth);
  window.localStorage.clear();
});

describe('useDashboardLayout first-run launch', () => {
  it('opens Get started in a window with nothing to restore', async () => {
    const { result } = renderHook(() => useDashboardLayout());
    expect(selections(result)).toEqual([null]);
    await act(async () => launch.release());
    await waitFor(() => expect(selections(result)).toEqual([{ kind: 'get-started' }]));
  });

  it('leaves a saved layout as it was', async () => {
    storeLayout(docSelection);
    const { result } = renderHook(() => useDashboardLayout());
    await act(async () => launch.release());
    expect(selections(result)).toEqual([docSelection]);
  });

  it('opens nothing when the first-run state says not to', async () => {
    launch.onboarding = MET_PATTY;
    const { result } = renderHook(() => useDashboardLayout());
    await act(async () => launch.release());
    expect(selections(result)).toEqual([null]);
  });

  it('does not replace a pane the person filled before the read came back', async () => {
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openTheme());
    await act(async () => launch.release());
    expect(selections(result)).toEqual([{ kind: 'theme' }]);
  });
});

describe('useDashboardLayout first-run launch with Home', () => {
  beforeEach(() => {
    flags.hub = true;
  });

  it('opens Home at once, then Get started beside it, with Home keeping the focus', async () => {
    const { result } = renderHook(() => useDashboardLayout());
    await waitFor(() => expect(selections(result)).toEqual([{ kind: 'hub' }]));
    const homeLeafId = result.current.activeLeafId;

    await act(async () => launch.release());
    await waitFor(() =>
      expect(selections(result)).toEqual([{ kind: 'hub' }, { kind: 'get-started' }])
    );
    expect(result.current.activeLeafId).toBe(homeLeafId);
  });

  it('opens Home alone once the first run is done', async () => {
    launch.onboarding = MET_PATTY;
    const { result } = renderHook(() => useDashboardLayout());
    await act(async () => launch.release());
    expect(selections(result)).toEqual([{ kind: 'hub' }]);
  });

  it('opens Get started alone in a window too narrow for two panes', async () => {
    setWindowWidth(900);
    const { result } = renderHook(() => useDashboardLayout());
    await act(async () => launch.release());
    await waitFor(() => expect(selections(result)).toEqual([{ kind: 'get-started' }]));
  });

  it('restores the two panes on reload without opening them again', async () => {
    const first = renderHook(() => useDashboardLayout());
    await act(async () => launch.release());
    await waitFor(() =>
      expect(selections(first.result)).toEqual([{ kind: 'hub' }, { kind: 'get-started' }])
    );
    // The layout is saved after a short pause.
    await waitFor(() =>
      expect(window.localStorage.getItem(LAYOUT_STORAGE_KEY)).toContain('get-started')
    );
    first.unmount();

    const second = renderHook(() => useDashboardLayout());
    await act(async () => launch.release());
    expect(selections(second.result)).toEqual([{ kind: 'hub' }, { kind: 'get-started' }]);
  });
});
