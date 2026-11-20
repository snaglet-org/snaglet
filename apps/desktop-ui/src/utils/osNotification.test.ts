import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeNotificationStatus } from '@snaglet/shared/types';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  emit: null as ((event: { payload: unknown }) => void) | null,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

const native = vi.hoisted(() => ({
  status: vi.fn(),
  requestPermission: vi.fn(),
}));
vi.mock('@desktop/features/reminders/nativeNotifications', () => ({
  nativeNotifications: native,
}));

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

import {
  __resetOsNotificationsForTests,
  closeOsNotification,
  osNotificationTag,
  showOsNotification,
} from './osNotification';

/** Stand-in for the Web Notification API: records every banner shown. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static shown: FakeNotification[] = [];

  onclose: (() => void) | null = null;
  onclick: (() => void) | null = null;
  close = vi.fn(() => {
    this.onclose?.();
  });

  constructor(
    readonly title: string,
    readonly options: NotificationOptions
  ) {
    FakeNotification.shown.push(this);
  }
}

describe('OS notifications', () => {
  beforeEach(() => {
    __resetOsNotificationsForTests();
    FakeNotification.shown = [];
    FakeNotification.permission = 'granted';
    vi.stubGlobal('Notification', FakeNotification);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives every ask its own banner, so two pending approvals never collapse', async () => {
    await showOsNotification({ id: 'notif-ask-a', type: 'tool_approval', title: 'A' });
    await showOsNotification({ id: 'notif-ask-b', type: 'tool_approval', title: 'B' });
    await showOsNotification({ id: 'notif-ask-c', type: 'mention', title: 'C' });

    expect(FakeNotification.shown.map((n) => n.options.tag)).toEqual([
      'notif-ask-a',
      'notif-ask-b',
      'notif-ask-c',
    ]);
  });

  it('keeps one banner per type for run failures', async () => {
    await showOsNotification({ id: 'notif-1', type: 'run_failed', title: 'A failed' });

    expect(FakeNotification.shown.map((n) => n.options.tag)).toEqual(['run_failed']);
    expect(osNotificationTag({ id: 'notif-1', type: 'run_failed' })).toBe('run_failed');
  });

  it('shows nothing for types that stay in-app', async () => {
    await showOsNotification({ id: 'notif-1', type: 'run_completed', title: 'Done' });

    expect(FakeNotification.shown).toEqual([]);
  });

  it('shows an in-app-only type when the caller forces it (a per-thread run alert)', async () => {
    await showOsNotification({
      id: 'notif-1',
      type: 'run_completed',
      title: 'Agent A completed',
      body: 'Agent A finished in “Build”.',
      force: true,
    });

    expect(FakeNotification.shown).toHaveLength(1);
    expect(FakeNotification.shown[0]?.title).toBe('Agent A completed');
    expect(FakeNotification.shown[0]?.options.body).toBe('Agent A finished in “Build”.');
    // Forcing one notification does not loosen the rule for the next.
    await showOsNotification({ id: 'notif-2', type: 'run_completed', title: 'Done' });
    expect(FakeNotification.shown).toHaveLength(1);
  });

  it('runs onClick when the user clicks a forced banner', async () => {
    const onClick = vi.fn();
    const focus = vi.fn();
    vi.stubGlobal('window', { Notification: FakeNotification, focus });

    await showOsNotification({
      id: 'notif-1',
      type: 'run_completed',
      title: 'Done',
      force: true,
      onClick,
    });
    FakeNotification.shown[0]?.onclick?.();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("closes a settled ask's banner and leaves the others", async () => {
    await showOsNotification({ id: 'notif-ask-a', type: 'tool_approval', title: 'A' });
    await showOsNotification({ id: 'notif-ask-b', type: 'tool_approval', title: 'B' });
    const [first, second] = FakeNotification.shown;

    closeOsNotification('notif-ask-a');
    closeOsNotification('notif-ask-a');

    expect(first?.close).toHaveBeenCalledTimes(1);
    expect(second?.close).not.toHaveBeenCalled();
  });

  it('ignores a dismissal for a banner that is gone or never shown', async () => {
    await showOsNotification({ id: 'notif-ask-a', type: 'tool_approval', title: 'A' });
    const [banner] = FakeNotification.shown;
    banner?.close();
    banner?.close.mockClear();

    closeOsNotification('notif-ask-a');
    closeOsNotification('notif-ask-unknown');

    expect(banner?.close).not.toHaveBeenCalled();
  });
});

describe('OS notifications in the browser (Web Notification API)', () => {
  beforeEach(() => {
    __resetOsNotificationsForTests();
    FakeNotification.shown = [];
    FakeNotification.permission = 'granted';
    tauri.invoke.mockReset();
    native.status.mockReset();
    vi.stubGlobal('Notification', FakeNotification);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never touches the native shell outside Tauri', async () => {
    const outcome = await showOsNotification({
      id: 'notif-ask-a',
      type: 'tool_approval',
      title: 'A',
    });

    expect(outcome).toEqual({ shown: true, sounded: true });
    expect(FakeNotification.shown).toHaveLength(1);
    expect(native.status).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('reports no banner and no sound when the browser denied permission', async () => {
    FakeNotification.permission = 'denied';

    const outcome = await showOsNotification({
      id: 'notif-ask-a',
      type: 'tool_approval',
      title: 'A',
    });

    expect(outcome).toEqual({ shown: false, sounded: false });
    expect(FakeNotification.shown).toEqual([]);
  });

  it('reports no banner when the type stays in-app', async () => {
    const outcome = await showOsNotification({ id: 'n', type: 'run_completed', title: 'Done' });
    expect(outcome).toEqual({ shown: false, sounded: false });
  });
});

describe('OS notifications in the desktop shell (native backend)', () => {
  const status = (over: Partial<NativeNotificationStatus> = {}): NativeNotificationStatus => ({
    platform: 'macos',
    supported: true,
    permission: 'granted',
    canSchedule: true,
    ...over,
  });
  const ask = { id: 'notif-ask-a', type: 'tool_approval' as const, title: 'Approve?' };

  beforeEach(() => {
    __resetOsNotificationsForTests();
    FakeNotification.shown = [];
    FakeNotification.permission = 'granted';
    // WKWebView: no usable Web Notification API at all.
    vi.stubGlobal('Notification', undefined);
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauri.invoke.mockReset().mockResolvedValue(true);
    tauri.listen.mockReset().mockImplementation(async (_name: string, cb: typeof tauri.emit) => {
      tauri.emit = cb;
      return vi.fn();
    });
    tauri.emit = null;
    native.status.mockReset().mockResolvedValue(status());
    native.requestPermission.mockReset().mockResolvedValue(status());
    toast.showToast.mockReset();
  });
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  });

  it('routes the banner to the shell, not the Web API, so WKWebView shows one', async () => {
    const outcome = await showOsNotification({ ...ask, body: 'shell: ls' });

    expect(tauri.invoke).toHaveBeenCalledWith('notifications_show', {
      id: 'notif-ask-a',
      title: 'Approve?',
      body: 'shell: ls',
      sound: 'default',
      tag: 'notif-ask-a',
    });
    expect(outcome).toEqual({ shown: true, sounded: true });
  });

  it('tags non-ask banners by type and honors the OS-type gate', async () => {
    await showOsNotification({ id: 'notif-1', type: 'run_failed', title: 'Failed' });
    await showOsNotification({ id: 'notif-2', type: 'run_completed', title: 'Done' });

    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith(
      'notifications_show',
      expect.objectContaining({ id: 'notif-1', tag: 'run_failed' })
    );
  });

  it('passes the chosen sound to the native banner and says it sounded', async () => {
    const outcome = await showOsNotification({
      id: 'notif-1',
      type: 'run_completed',
      title: 'Done',
      force: true,
      sound: 'marimba',
    });

    expect(tauri.invoke).toHaveBeenCalledWith(
      'notifications_show',
      expect.objectContaining({ sound: 'marimba' })
    );
    expect(outcome).toEqual({ shown: true, sounded: true });
  });

  it('a banner asked to be silent shows but does not count as a sound', async () => {
    const outcome = await showOsNotification({
      id: 'notif-1',
      type: 'run_completed',
      title: 'Done',
      force: true,
      sound: 'none',
    });

    expect(outcome).toEqual({ shown: true, sounded: false });
  });

  it('gives one banner and one outcome to a repeated id (tray event plus run alert)', async () => {
    const [first, second] = await Promise.all([
      showOsNotification({ id: 'notif-1', type: 'run_failed', title: 'Failed' }),
      showOsNotification({
        id: 'notif-1',
        type: 'run_failed',
        title: 'Failed',
        force: true,
        sound: 'chime',
      }),
    ]);
    const third = await showOsNotification({ id: 'notif-1', type: 'run_failed', title: 'Failed' });

    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toEqual(first);
  });

  it('lets the later asker of a shared banner carry the click handler', async () => {
    const onClick = vi.fn();
    await showOsNotification({ id: 'notif-1', type: 'run_failed', title: 'Failed' });
    await showOsNotification({
      id: 'notif-1',
      type: 'run_failed',
      title: 'Failed',
      force: true,
      onClick,
    });
    await vi.waitFor(() => expect(tauri.emit).not.toBeNull());

    tauri.emit?.({ payload: { id: 'notif-1' } });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
  });

  it('retries after a refused banner instead of remembering the refusal', async () => {
    tauri.invoke.mockResolvedValueOnce(false);

    const refused = await showOsNotification(ask);
    const retried = await showOsNotification(ask);

    expect(refused).toEqual({ shown: false, sounded: false });
    expect(retried).toEqual({ shown: true, sounded: true });
  });

  it('with macOS permission off: shows nothing, reports no sound, and tells the user once', async () => {
    native.status.mockResolvedValue(status({ permission: 'denied' }));

    const first = await showOsNotification(ask);
    const second = await showOsNotification({ ...ask, id: 'notif-ask-b' });

    expect(first).toEqual({ shown: false, sounded: false });
    expect(second).toEqual({ shown: false, sounded: false });
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledTimes(1);
    expect(toast.showToast.mock.calls[0]?.[0]).toMatch(/System Settings/);
    expect(toast.showToast.mock.calls[0]?.[0]).toMatch(/Snaglet/);
  });

  it('does not use the Web API when the shell reports denied, even if it exists', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    native.status.mockResolvedValue(status({ permission: 'denied' }));

    await showOsNotification(ask);

    expect(FakeNotification.shown).toEqual([]);
  });

  it('asks the OS for permission once while it is undecided, then shows', async () => {
    native.status.mockResolvedValue(status({ permission: 'unknown' }));
    native.requestPermission.mockResolvedValue(status({ permission: 'granted' }));

    const outcome = await showOsNotification(ask);

    expect(native.requestPermission).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ shown: true, sounded: true });
  });

  it('shows the notice when the permission prompt is answered no', async () => {
    native.status.mockResolvedValue(status({ permission: 'unknown' }));
    native.requestPermission.mockResolvedValue(status({ permission: 'denied' }));

    const outcome = await showOsNotification(ask);

    expect(outcome).toEqual({ shown: false, sounded: false });
    expect(toast.showToast).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Web API on a platform with no native backend', async () => {
    native.status.mockResolvedValue(status({ supported: false, permission: 'unknown' }));
    vi.stubGlobal('Notification', FakeNotification);

    const outcome = await showOsNotification(ask);

    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(FakeNotification.shown).toHaveLength(1);
    expect(outcome).toEqual({ shown: true, sounded: true });
  });

  it('falls back to the Web API on a shell without the command', async () => {
    tauri.invoke.mockRejectedValue(new Error('command notifications_show not found'));
    vi.stubGlobal('Notification', FakeNotification);

    const outcome = await showOsNotification(ask);

    expect(FakeNotification.shown).toHaveLength(1);
    expect(outcome).toEqual({ shown: true, sounded: true });
  });

  it('is silent, not broken, when neither backend can show a banner', async () => {
    native.status.mockResolvedValue(status({ supported: false, permission: 'unknown' }));

    await expect(showOsNotification(ask)).resolves.toEqual({ shown: false, sounded: false });
  });

  it('runs onClick when the shell reports a click on that banner, once', async () => {
    const onClick = vi.fn();
    await showOsNotification({ ...ask, onClick });
    await vi.waitFor(() => expect(tauri.emit).not.toBeNull());

    tauri.emit?.({ payload: { id: 'someone-else' } });
    expect(onClick).not.toHaveBeenCalled();
    tauri.emit?.({ payload: { id: 'notif-ask-a' } });
    tauri.emit?.({ payload: { id: 'notif-ask-a' } });

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('closes a settled ask natively and leaves other banners', async () => {
    await showOsNotification(ask);
    await showOsNotification({ ...ask, id: 'notif-ask-b' });
    tauri.invoke.mockClear();

    closeOsNotification('notif-ask-a');
    closeOsNotification('notif-unknown');
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalled());

    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith('notifications_close', { id: 'notif-ask-a' });
  });
});
