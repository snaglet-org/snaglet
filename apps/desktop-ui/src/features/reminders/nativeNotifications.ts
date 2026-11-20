/**
 * Native OS notifications for reminders, behind one platform-neutral
 * interface (status / requestPermission / sync / cancelAll / onClicked /
 * takeLaunchClick).
 *
 * The desktop shell implements it with Tauri commands (`notifications_*`)
 * and the `reminder-notification-clicked` event. A sync replaces every pending
 * Snaglet notification; the shell keeps the nearest {@link NATIVE_SCHEDULE_CAP}.
 * Where the commands are missing (Windows, Linux, the browser dev UI) an
 * invoke error reads as `supported: false`; the in-app banner carries every
 * reminder either way.
 *
 * The module remembers which reminder keys the OS holds, so the banner plays
 * the sound only when the native notification won't ({@link nativeWillSound}).
 */
import type {
  NativeNotificationPlatform,
  NativeNotificationStatus,
  ReminderDue,
  ReminderItemRef,
} from '@snaglet/shared/types';
import { isTauriEnv } from '@desktop/utils/tauriEnv';

/** The shell keeps at most this many scheduled notifications (the nearest). */
export const NATIVE_SCHEDULE_CAP = 60;

const CLICKED_EVENT = 'reminder-notification-clicked';

export interface NativeNotificationClick {
  key: string;
  item: ReminderItemRef;
}

export interface NativeNotifications {
  status(): Promise<NativeNotificationStatus>;
  requestPermission(): Promise<NativeNotificationStatus>;
  /** Replace every pending Snaglet notification with these. */
  sync(reminders: ReminderDue[]): Promise<void>;
  cancelAll(): Promise<void>;
  /** Clicks on a native notification; returns the unsubscribe. */
  onClicked(handler: (click: NativeNotificationClick) => void): () => void;
  /**
   * The click that launched Snaglet from quit (it came before the window), once;
   * null when there was none. Handle it like an {@link onClicked} click.
   */
  takeLaunchClick(): Promise<NativeNotificationClick | null>;
}

function detectPlatform(): NativeNotificationPlatform {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const hint = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`.toLowerCase();
  if (hint.includes('mac')) return 'macos';
  if (hint.includes('win')) return 'windows';
  return 'linux';
}

function unsupported(): NativeNotificationStatus {
  return {
    platform: detectPlatform(),
    supported: false,
    permission: 'unknown',
    canSchedule: false,
  };
}

function parseStatus(value: unknown): NativeNotificationStatus {
  if (!value || typeof value !== 'object') return unsupported();
  const v = value as Partial<NativeNotificationStatus>;
  const platform =
    v.platform === 'macos' || v.platform === 'windows' || v.platform === 'linux'
      ? v.platform
      : detectPlatform();
  const permission =
    v.permission === 'granted' || v.permission === 'denied' ? v.permission : 'unknown';
  return {
    platform,
    supported: v.supported === true,
    permission,
    canSchedule: v.canSchedule === true,
  };
}

async function invokeShell<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

let lastStatus: NativeNotificationStatus | null = null;
/** Keys the OS holds after the last successful sync (empty when unknown). */
let scheduledKeys = new Set<string>();

function remember(status: NativeNotificationStatus): NativeNotificationStatus {
  lastStatus = status;
  if (!status.supported) scheduledKeys = new Set();
  return status;
}

/** What the shell keeps of a sync: future ones, the nearest {@link NATIVE_SCHEDULE_CAP}. */
function keptBySchedule(reminders: readonly ReminderDue[], now: number): Set<string> {
  return new Set(
    reminders
      .filter((r) => Date.parse(r.fireAt) > now)
      .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt))
      .slice(0, NATIVE_SCHEDULE_CAP)
      .map((r) => r.key)
  );
}

async function command(
  cmd: 'notifications_status' | 'notifications_request_permission'
): Promise<NativeNotificationStatus> {
  if (!isTauriEnv()) return remember(unsupported());
  try {
    return remember(parseStatus(await invokeShell<unknown>(cmd)));
  } catch {
    // The shell lacks the command, or the platform refused.
    return remember(unsupported());
  }
}

export const nativeNotifications: NativeNotifications = {
  status: () => command('notifications_status'),
  requestPermission: () => command('notifications_request_permission'),

  async sync(reminders) {
    if (!isTauriEnv()) return;
    const kept = keptBySchedule(reminders, Date.now());
    try {
      await invokeShell<unknown>('notifications_sync', { reminders });
      scheduledKeys = kept;
    } catch {
      // Unknown what the OS holds now: let the banner sound rather than miss one.
      scheduledKeys = new Set();
    }
  },

  async cancelAll() {
    scheduledKeys = new Set();
    if (!isTauriEnv()) return;
    try {
      await invokeShell<unknown>('notifications_cancel_all');
    } catch {
      // Nothing to cancel on a shell without native notifications.
    }
  },

  async takeLaunchClick() {
    if (!isTauriEnv()) return null;
    try {
      return parseClick(await invokeShell<unknown>('notifications_take_clicked'));
    } catch {
      // The shell lacks the command: no launch click to hand over.
      return null;
    }
  },

  onClicked(handler) {
    if (!isTauriEnv()) return () => undefined;
    let unlisten: (() => void) | null = null;
    let stopped = false;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(CLICKED_EVENT, (event) => {
          const click = parseClick(event.payload);
          if (click) handler(click);
        })
      )
      .then((stop) => {
        if (stopped) stop();
        else unlisten = stop;
      })
      .catch((err: unknown) => {
        // No event bridge: a click just brings Snaglet forward.
        console.warn('[reminders] notification clicks unavailable', err);
      });
    return () => {
      stopped = true;
      unlisten?.();
      unlisten = null;
    };
  },
};

function parseClick(payload: unknown): NativeNotificationClick | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { key?: unknown; item?: unknown };
  const item = parseReminderItem(p.item);
  if (typeof p.key !== 'string' || !item) return null;
  return { key: p.key, item };
}

/** A {@link ReminderItemRef} from untrusted data, or null. */
export function parseReminderItem(value: unknown): ReminderItemRef | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === 'string' && v[k] !== '' ? (v[k] as string) : null);
  switch (v.kind) {
    case 'event': {
      const eventId = str('eventId');
      return eventId ? { kind: 'event', eventId } : null;
    }
    case 'table_entry': {
      const tableId = str('tableId');
      const entryId = str('entryId');
      const fieldId = str('fieldId');
      return tableId && entryId && fieldId
        ? { kind: 'table_entry', tableId, entryId, fieldId }
        : null;
    }
    case 'automation': {
      const automationId = str('automationId');
      return automationId ? { kind: 'automation', automationId } : null;
    }
    default:
      return null;
  }
}

/** Native notifications can post here (supported, permission granted). */
export function nativeGranted(status: NativeNotificationStatus | null = lastStatus): boolean {
  return !!status && status.supported && status.permission === 'granted';
}

/**
 * Whether the OS notification for `key` plays its sound: native is on and
 * granted, the platform schedules ahead, and the last sync handed it this
 * reminder. Otherwise the in-app banner plays the sound.
 */
export function nativeWillSound(key: string): boolean {
  return nativeGranted() && !!lastStatus?.canSchedule && scheduledKeys.has(key);
}

export function __resetNativeNotificationsForTests(): void {
  lastStatus = null;
  scheduledKeys = new Set();
}
