/**
 * Unload flush: a reload or window close inside an autosave debounce must
 * still send the last edit. Pins the registry (one run per unload, errors
 * isolated, reset when the page stays), the keepalive marking of requests
 * started during the flush, and each autosave hook's registration.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '@desktop/utils/api/core';
import { useAutosave } from '@desktop/features/rich-markdown/editor/useAutosave';
import { useWorkspaceEditorAutosave } from '@desktop/features/rich-markdown/workspace-editor/useWorkspaceEditorAutosave';
import { useDebouncedSave } from '@desktop/pages/Dashboard/hooks/useDebouncedSave';
import { registerUnloadFlush, withUnloadKeepalive } from './unloadFlush';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const reload = () => {
  window.dispatchEvent(new Event('beforeunload'));
  window.dispatchEvent(new Event('pagehide'));
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // A page that stays (or comes back) takes normal requests again.
  window.dispatchEvent(new Event('pageshow'));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('registerUnloadFlush', () => {
  it('runs every flush once per unload, isolating failures, until unregistered', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = vi.fn(() => {
      throw new Error('boom');
    });
    const second = vi.fn(() => Promise.reject(new Error('offline')));
    const third = vi.fn();
    const stops = [first, second, third].map((flush) => registerUnloadFlush(flush));

    reload();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);

    stops.forEach((stop) => stop());
    window.dispatchEvent(new Event('pageshow'));
    reload();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('marks requests keepalive only while the flush runs, and only small bodies', () => {
    const init = { method: 'PATCH', body: '{"title":"Notes"}' };
    expect(withUnloadKeepalive(init)).toBe(init);

    const seen: RequestInit[] = [];
    const stop = registerUnloadFlush(() => {
      seen.push(withUnloadKeepalive(init));
      seen.push(withUnloadKeepalive({ method: 'PATCH', body: 'x'.repeat(70 * 1024) }));
      seen.push(withUnloadKeepalive({ method: 'POST', body: new FormData() }));
    });
    reload();

    expect(seen[0]).toEqual({ ...init, keepalive: true });
    expect(seen[1].keepalive).toBeUndefined();
    expect(seen[2].keepalive).toBeUndefined();

    // The unload was canceled: the page stays and requests are normal again.
    vi.advanceTimersByTime(0);
    expect(withUnloadKeepalive(init)).toBe(init);
    stop();
  });

  it('sends API writes started by a flush as keepalive fetches', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, data: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const stop = registerUnloadFlush(() =>
      fetchJson('/api/docs/doc-1', { method: 'PATCH', body: '{"content":"last edit"}' })
    );

    reload();
    await act(async () => undefined);

    expect(fetchMock).toHaveBeenCalledWith('/api/docs/doc-1', {
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
      body: '{"content":"last edit"}',
      keepalive: true,
    });
    stop();
  });
});

describe('autosave hooks flush on unload', () => {
  it('useAutosave sends the value still waiting on its debounce, once', async () => {
    const save = vi.fn(async () => undefined);
    const { result, unmount } = renderHook(() => useAutosave({ save, delayMs: 600 }));

    act(() => result.current.markChanged('last edit'));
    reload();
    expect(save).toHaveBeenCalledWith('last edit');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(save).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('useAutosave stays quiet with nothing unsaved, and after unmount', () => {
    const save = vi.fn(async () => undefined);
    const { result, unmount } = renderHook(() => useAutosave({ save }));
    reload();
    expect(save).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pageshow'));
    act(() => result.current.markChanged('draft'));
    unmount();
    reload();
    expect(save).not.toHaveBeenCalled();
  });

  it('useWorkspaceEditorAutosave writes the draft, unless the running save carries it', async () => {
    let finish: (value: string) => void = () => undefined;
    const onSave = vi.fn(
      (next: string) =>
        new Promise<string>((resolve) => {
          finish = () => resolve(next);
        })
    );
    const { result } = renderHook(() =>
      useWorkspaceEditorAutosave({ savedValue: 'saved', onSave, delayMs: 600 })
    );

    // A save in flight for exactly the current draft: nothing more to send.
    act(() => result.current.onChange('first'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    reload();
    expect(onSave).toHaveBeenCalledTimes(1);

    // A newer edit behind the running save goes out on unload.
    window.dispatchEvent(new Event('pageshow'));
    act(() => result.current.onChange('second'));
    reload();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith('second');
    await act(async () => finish('first'));
  });

  it('useDebouncedSave runs a scheduled save, but not a draft the host only marked dirty', async () => {
    const persist = vi.fn(async () => undefined);
    const { result } = renderHook(() => useDebouncedSave(persist, { delayMs: 400 }));

    act(() => result.current.setSaveState('dirty'));
    reload();
    expect(persist).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pageshow'));
    act(() => result.current.queueSave('debounced'));
    reload();
    expect(persist).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
