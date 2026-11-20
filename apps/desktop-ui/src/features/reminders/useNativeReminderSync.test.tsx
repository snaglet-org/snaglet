import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeNotificationStatus, WsMessage } from '@snaglet/shared/types';

const api = vi.hoisted(() => ({ upcoming: vi.fn() }));
vi.mock('@desktop/utils/api/reminders', () => ({ remindersApi: api }));

const native = vi.hoisted(() => ({ status: vi.fn(), sync: vi.fn() }));
vi.mock('./nativeNotifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./nativeNotifications')>()),
  nativeNotifications: native,
}));

import { notifyRemindersChanged } from './remindersEvents';
import {
  REMINDER_SYNC_DEBOUNCE_MS,
  REMINDER_SYNC_HOURS,
  REMINDER_SYNC_INTERVAL_MS,
  useNativeReminderSync,
} from './useNativeReminderSync';

const GRANTED: NativeNotificationStatus = {
  platform: 'macos',
  supported: true,
  permission: 'granted',
  canSchedule: true,
};

const LIST = [{ key: 'k1' }];

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function mount() {
  const listeners = new Set<(msg: WsMessage) => void>();
  const addMessageListener = (l: (msg: WsMessage) => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const view = renderHook(() => useNativeReminderSync(addMessageListener));
  const frame = (type: string) => {
    for (const l of listeners) l({ type, payload: {} });
  };
  return { ...view, frame, listeners };
}

describe('useNativeReminderSync', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    api.upcoming.mockReset().mockResolvedValue({ reminders: LIST, until: '' });
    native.status.mockReset().mockResolvedValue(GRANTED);
    native.sync.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('does nothing where native notifications are unsupported', async () => {
    native.status.mockResolvedValue({ ...GRANTED, supported: false, permission: 'unknown' });
    const { frame, listeners } = mount();
    await flush();
    frame('reminders:changed');
    await act(async () => vi.advanceTimersByTime(REMINDER_SYNC_INTERVAL_MS * 2));
    await flush();
    expect(api.upcoming).not.toHaveBeenCalled();
    expect(native.sync).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('syncs the next 72 hours on start', async () => {
    mount();
    await flush();
    expect(api.upcoming).toHaveBeenCalledWith(REMINDER_SYNC_HOURS);
    expect(native.sync).toHaveBeenCalledWith(LIST);
  });

  it('skips the fetch while permission is not granted', async () => {
    native.status.mockResolvedValue({ ...GRANTED, permission: 'denied' });
    mount();
    await flush();
    expect(api.upcoming).not.toHaveBeenCalled();
  });

  it('collapses a burst of reminders:changed (and local saves) into one sync', async () => {
    const { frame } = mount();
    await flush();
    native.sync.mockClear();
    frame('reminders:changed');
    frame('reminders:changed');
    notifyRemindersChanged();
    frame('calendar:changed');
    await act(async () => vi.advanceTimersByTime(REMINDER_SYNC_DEBOUNCE_MS - 1));
    await flush();
    expect(native.sync).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(native.sync).toHaveBeenCalledTimes(1);
  });

  it('resyncs every 30 minutes and stops on unmount', async () => {
    const { unmount } = mount();
    await flush();
    native.sync.mockClear();
    await act(async () => vi.advanceTimersByTime(REMINDER_SYNC_INTERVAL_MS));
    await flush();
    expect(native.sync).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => vi.advanceTimersByTime(REMINDER_SYNC_INTERVAL_MS));
    await flush();
    expect(native.sync).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch leaves the schedule alone and tries again next time', async () => {
    api.upcoming.mockRejectedValueOnce(new Error('offline'));
    const { frame } = mount();
    await flush();
    expect(native.sync).not.toHaveBeenCalled();
    frame('reminders:changed');
    await act(async () => vi.advanceTimersByTime(REMINDER_SYNC_DEBOUNCE_MS));
    await flush();
    expect(native.sync).toHaveBeenCalledWith(LIST);
  });
});
