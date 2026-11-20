/**
 * Display-preferences store — default behavior, persistence, and the reload
 * path (a fresh module import must honor what localStorage says).
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getShowAgentPopups, setShowAgentPopups, useShowAgentPopups } from './displayPrefs';

const KEY = 'snaglet.dashboard.agentPopups.show';

afterEach(() => {
  setShowAgentPopups(true);
  window.localStorage.removeItem(KEY);
});

describe('showAgentPopups preference', () => {
  it('defaults to on', () => {
    expect(getShowAgentPopups()).toBe(true);
    const { result } = renderHook(() => useShowAgentPopups());
    expect(result.current).toBe(true);
  });

  it('applies live to subscribed hooks and persists the choice', () => {
    const { result } = renderHook(() => useShowAgentPopups());

    act(() => setShowAgentPopups(false));
    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe('false');

    act(() => setShowAgentPopups(true));
    expect(result.current).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe('true');
  });

  it('honors a persisted opt-out on module load (the reload path)', async () => {
    window.localStorage.setItem(KEY, 'false');
    vi.resetModules();
    const fresh = await import('./displayPrefs');
    expect(fresh.getShowAgentPopups()).toBe(false);
    // Reset the fresh copy too — module registries survive this test file.
    fresh.setShowAgentPopups(true);
  });

  it('treats anything but the exact string "false" as on', async () => {
    window.localStorage.setItem(KEY, 'FALSE');
    vi.resetModules();
    const fresh = await import('./displayPrefs');
    expect(fresh.getShowAgentPopups()).toBe(true);
  });
});
