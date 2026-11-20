import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderDue } from '@snaglet/shared/types';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  emit: null as ((event: { payload: unknown }) => void) | null,
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import {
  NATIVE_SCHEDULE_CAP,
  __resetNativeNotificationsForTests,
  nativeNotifications,
  nativeWillSound,
} from './nativeNotifications';

const GRANTED = { platform: 'macos', supported: true, permission: 'granted', canSchedule: true };

function due(key: string, fireInMs: number): ReminderDue {
  const fireAt = new Date(Date.now() + fireInMs).toISOString();
  return {
    key,
    item: { kind: 'event', eventId: 'event-1111111111111-aaaaaaaaa' },
    title: 'Standup',
    calendarName: 'Work',
    startsAt: fireAt,
    fireAt,
    offset: null,
    sound: 'chime',
  };
}

const inTauri = () => {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
};

describe('nativeNotifications', () => {
  beforeEach(() => {
    __resetNativeNotificationsForTests();
    tauri.invoke.mockReset();
    tauri.listen.mockReset();
    tauri.unlisten.mockReset();
    tauri.emit = null;
    tauri.listen.mockImplementation(async (_name: string, cb: typeof tauri.emit) => {
      tauri.emit = cb;
      return tauri.unlisten;
    });
  });
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  describe('in the browser', () => {
    it('is unsupported and never invokes the shell', async () => {
      const status = await nativeNotifications.status();
      expect(status).toMatchObject({ supported: false, permission: 'unknown', canSchedule: false });
      expect(await nativeNotifications.requestPermission()).toMatchObject({ supported: false });
      await nativeNotifications.sync([due('k1', 60_000)]);
      await nativeNotifications.cancelAll();
      const stop = nativeNotifications.onClicked(vi.fn());
      stop();
      expect(await nativeNotifications.takeLaunchClick()).toBeNull();
      expect(tauri.invoke).not.toHaveBeenCalled();
      expect(tauri.listen).not.toHaveBeenCalled();
      expect(nativeWillSound('k1')).toBe(false);
    });
  });

  describe('in the desktop shell', () => {
    beforeEach(inTauri);

    it('reads the status from notifications_status', async () => {
      tauri.invoke.mockResolvedValue(GRANTED);
      expect(await nativeNotifications.status()).toEqual(GRANTED);
      expect(tauri.invoke).toHaveBeenCalledWith('notifications_status', undefined);
    });

    it('asks for permission with notifications_request_permission', async () => {
      tauri.invoke.mockResolvedValue({ ...GRANTED, permission: 'denied' });
      expect(await nativeNotifications.requestPermission()).toMatchObject({ permission: 'denied' });
      expect(tauri.invoke).toHaveBeenCalledWith('notifications_request_permission', undefined);
    });

    it('reads an invoke error (an older shell without the command) as unsupported', async () => {
      tauri.invoke.mockRejectedValue(new Error('command notifications_status not found'));
      expect(await nativeNotifications.status()).toMatchObject({
        supported: false,
        permission: 'unknown',
      });
      expect(nativeWillSound('k1')).toBe(false);
    });

    it('syncs the list and knows which reminders the OS will sound', async () => {
      tauri.invoke.mockResolvedValue(GRANTED);
      await nativeNotifications.status();
      const reminders = [due('soon', 60_000), due('past', -60_000)];
      await nativeNotifications.sync(reminders);
      expect(tauri.invoke).toHaveBeenLastCalledWith('notifications_sync', { reminders });
      expect(nativeWillSound('soon')).toBe(true);
      // The shell skips past ones, and anything not handed to it.
      expect(nativeWillSound('past')).toBe(false);
      expect(nativeWillSound('other')).toBe(false);
    });

    it('keeps only the nearest reminders the shell schedules', async () => {
      tauri.invoke.mockResolvedValue(GRANTED);
      await nativeNotifications.status();
      const many = Array.from({ length: NATIVE_SCHEDULE_CAP + 1 }, (_, i) =>
        due(`k${i}`, (i + 1) * 60_000)
      );
      await nativeNotifications.sync([...many].reverse());
      expect(nativeWillSound('k0')).toBe(true);
      expect(nativeWillSound(`k${NATIVE_SCHEDULE_CAP - 1}`)).toBe(true);
      expect(nativeWillSound(`k${NATIVE_SCHEDULE_CAP}`)).toBe(false);
    });

    it('lets the banner sound when permission is not granted or the sync failed', async () => {
      tauri.invoke.mockResolvedValueOnce({ ...GRANTED, permission: 'denied' });
      await nativeNotifications.status();
      tauri.invoke.mockResolvedValueOnce(undefined);
      await nativeNotifications.sync([due('k1', 60_000)]);
      expect(nativeWillSound('k1')).toBe(false);

      tauri.invoke.mockResolvedValueOnce(GRANTED);
      await nativeNotifications.status();
      tauri.invoke.mockRejectedValueOnce(new Error('boom'));
      await nativeNotifications.sync([due('k1', 60_000)]);
      expect(nativeWillSound('k1')).toBe(false);
    });

    it('cancelAll clears the schedule', async () => {
      tauri.invoke.mockResolvedValue(GRANTED);
      await nativeNotifications.status();
      await nativeNotifications.sync([due('k1', 60_000)]);
      await nativeNotifications.cancelAll();
      expect(tauri.invoke).toHaveBeenLastCalledWith('notifications_cancel_all', undefined);
      expect(nativeWillSound('k1')).toBe(false);
    });

    it('hands over the click that launched Snaglet, and none from an older shell', async () => {
      const item = { kind: 'event', eventId: 'event-1111111111111-aaaaaaaaa' };
      tauri.invoke.mockResolvedValueOnce({ key: 'k1', item });
      expect(await nativeNotifications.takeLaunchClick()).toEqual({ key: 'k1', item });
      expect(tauri.invoke).toHaveBeenCalledWith('notifications_take_clicked', undefined);
      tauri.invoke.mockResolvedValueOnce(null);
      expect(await nativeNotifications.takeLaunchClick()).toBeNull();
      tauri.invoke.mockRejectedValueOnce(new Error('unknown command'));
      expect(await nativeNotifications.takeLaunchClick()).toBeNull();
    });

    it('reports notification clicks and stops listening', async () => {
      const handler = vi.fn();
      const stop = nativeNotifications.onClicked(handler);
      await vi.waitFor(() => expect(tauri.emit).not.toBeNull());
      expect(tauri.listen).toHaveBeenCalledWith(
        'reminder-notification-clicked',
        expect.any(Function)
      );
      const item = { kind: 'automation', automationId: 'automation-1111111111111-aaaaaaaaa' };
      tauri.emit?.({ payload: { key: 'k1', item } });
      tauri.emit?.({ payload: { key: 'k2', item: { kind: 'nope' } } });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ key: 'k1', item });
      stop();
      expect(tauri.unlisten).toHaveBeenCalled();
    });
  });
});
