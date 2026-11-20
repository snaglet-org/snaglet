/**
 * OS-level notification helper. In the Tauri shell, banners go to the native
 * backend (`notifications_show` / `notifications_close`), because WKWebView
 * has no usable Web Notification API; the browser and shells without a native
 * backend use the Web Notification API. The outcome reports whether the
 * banner played a sound so the caller plays the in-app sound only when it
 * didn't. If OS permission is denied, a toast says so once per session.
 */

import type {
  NativeNotificationStatus,
  NotificationType,
  ReminderSoundId,
} from '@snaglet/shared/types';
import { nativeNotifications } from '@desktop/features/reminders/nativeNotifications';
import { showToast } from '@desktop/utils/toast';
import { isTauriEnv } from '@desktop/utils/tauriEnv';

/** Notification types that should trigger an OS notification. */
const OS_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'run_failed',
  'mention',
  'tool_approval',
]);

/**
 * Types that announce an agent ask (a tool-permission prompt, an Ask
 * question, a reply asking the user something). Each gets its own banner,
 * tagged with its notification id, so two pending approvals never collapse
 * into one; other types share one banner per type.
 */
const PER_ASK_TYPES: ReadonlySet<NotificationType> = new Set(['mention', 'tool_approval']);

/** Shell event emitted when the user clicks a native banner; payload `{ id }`. */
const BANNER_CLICKED_EVENT = 'banner-notification-clicked';

/** How long a native banner's id is remembered to drop a duplicate for it. */
const NATIVE_DEDUPE_WINDOW_MS = 30_000;

/** What happened to one request for a banner. */
export interface OsNotificationOutcome {
  /** A banner was handed to the OS (or the browser). */
  shown: boolean;
  /**
   * The OS banner plays its own sound, so the in-app sound must stay quiet.
   * False when no banner appeared, or the native banner was asked to be silent.
   */
  sounded: boolean;
}

const NOT_SHOWN: OsNotificationOutcome = { shown: false, sounded: false };

/** Banners still on screen for asks, by notification id, so a settled ask can close its own. */
const askBanners = new Map<string, Notification>();

/** Native ask banners (tag === id) handed to the shell, by notification id. */
const nativeAskIds = new Set<string>();

/** Click handlers for native banners, by notification id. */
const nativeClickHandlers = new Map<string, () => void>();
const MAX_CLICK_HANDLERS = 100;

/**
 * Native banners requested recently, by notification id. One run end can ask
 * twice for the same id (the tray `notification.created` and the per-thread
 * `thread.run_alert`); the second asker gets the first one's outcome instead
 * of a second banner, so the user never hears two sounds. Holds the promise
 * so a request still in flight is shared too.
 */
const recentNative = new Map<
  string,
  { at: number; result: Promise<OsNotificationOutcome | null> }
>();

/** The permission-off notice is shown once until permission comes back. */
let deniedNoticeShown = false;
/** The OS prompt is requested at most once per session. */
let permissionRequested = false;
let clickListenerStarted = false;

/** The OS tag for a notification: its own id for an ask, its type otherwise. */
export function osNotificationTag(params: { id: string; type: NotificationType }): string {
  return PER_ASK_TYPES.has(params.type) ? params.id : params.type;
}

/** Whether banners go through the desktop shell's native backend in this process. */
function usesNativeBanners(): boolean {
  return isTauriEnv();
}

async function invokeShell<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

function permissionOffMessage(platform: NativeNotificationStatus['platform']): string {
  return platform === 'macos'
    ? 'Snaglet can’t show banners: notifications are off for Snaglet. Turn them on in System Settings › Notifications › Snaglet.'
    : 'Snaglet can’t show banners: notifications are off for Snaglet in your system settings.';
}

/** Tell the user, once, that the OS is blocking Snaglet's banners. */
function surfacePermissionOff(status: NativeNotificationStatus): void {
  console.warn(
    '[notifications] OS notification permission for Snaglet is off; banners are skipped'
  );
  if (deniedNoticeShown) return;
  deniedNoticeShown = true;
  showToast(permissionOffMessage(status.platform), {
    id: 'os-notifications-off',
    durationMs: 10_000,
  });
}

/** The native status, prompting the OS for permission the first time it is undecided. */
async function nativeStatusForBanner(): Promise<NativeNotificationStatus> {
  let status = await nativeNotifications.status();
  if (status.supported && status.permission === 'unknown' && !permissionRequested) {
    permissionRequested = true;
    status = await nativeNotifications.requestPermission();
  }
  return status;
}

function startClickListener(): void {
  if (clickListenerStarted) return;
  clickListenerStarted = true;
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<unknown>(BANNER_CLICKED_EVENT, (event) => {
        const payload = event.payload as { id?: unknown } | null;
        const id = typeof payload?.id === 'string' ? payload.id : null;
        if (!id) return;
        const handler = nativeClickHandlers.get(id);
        nativeClickHandlers.delete(id);
        // The shell already brought the window forward.
        handler?.();
      })
    )
    .catch((err: unknown) => {
      clickListenerStarted = false;
      console.warn('[notifications] banner clicks unavailable', err);
    });
}

function rememberClickHandler(id: string, onClick: (() => void) | undefined): void {
  if (!onClick) return;
  nativeClickHandlers.delete(id);
  nativeClickHandlers.set(id, onClick);
  while (nativeClickHandlers.size > MAX_CLICK_HANDLERS) {
    const oldest = nativeClickHandlers.keys().next().value;
    if (oldest === undefined) break;
    nativeClickHandlers.delete(oldest);
  }
}

/**
 * Show the banner through the shell. Returns null when the native backend
 * can't be used here (unsupported platform, missing command, invoke failure), so
 * the caller falls back to the Web API; an outcome otherwise.
 */
function showNative(params: ShowParams, tag: string): Promise<OsNotificationOutcome | null> {
  const now = Date.now();
  for (const [id, entry] of recentNative) {
    if (now - entry.at >= NATIVE_DEDUPE_WINDOW_MS) recentNative.delete(id);
  }
  const recent = recentNative.get(params.id);
  if (recent) {
    // The same notification again (e.g. the run alert after its tray event):
    // no second banner or sound, but the later asker may carry the click
    // handler that opens the thread.
    void recent.result.then((outcome) => {
      if (outcome?.shown) {
        startClickListener();
        rememberClickHandler(params.id, params.onClick);
      }
    });
    return recent.result;
  }

  const result = requestNativeBanner(params, tag);
  recentNative.set(params.id, { at: now, result });
  void result.then((outcome) => {
    // Only a banner that appeared blocks a repeat; a failed try may be retried.
    if (!outcome?.shown && recentNative.get(params.id)?.result === result) {
      recentNative.delete(params.id);
    }
  });
  return result;
}

async function requestNativeBanner(
  params: ShowParams,
  tag: string
): Promise<OsNotificationOutcome | null> {
  const status = await nativeStatusForBanner();
  if (!status.supported) return null;
  if (status.permission === 'denied') {
    surfacePermissionOff(status);
    return NOT_SHOWN;
  }
  if (status.permission !== 'granted') return NOT_SHOWN;
  deniedNoticeShown = false;

  const sound = params.sound ?? 'default';
  startClickListener();
  rememberClickHandler(params.id, params.onClick);
  let accepted: boolean;
  try {
    accepted = await invokeShell<boolean>('notifications_show', {
      id: params.id,
      title: params.title,
      body: params.body ?? null,
      sound,
      tag,
    });
  } catch {
    // The command is unavailable or failed: let the Web API try.
    nativeClickHandlers.delete(params.id);
    return null;
  }
  if (!accepted) {
    nativeClickHandlers.delete(params.id);
    return NOT_SHOWN;
  }
  if (tag === params.id) nativeAskIds.add(params.id);
  return { shown: true, sounded: sound !== 'none' };
}

/**
 * Request notification permission if not already granted. Returns true
 * when permission is (or becomes) 'granted'.
 */
async function ensurePermission(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

/** The Web Notification API path: browser, dev, and shells with no native backend. */
async function showWeb(params: ShowParams, tag: string): Promise<OsNotificationOutcome> {
  const permitted = await ensurePermission();
  if (!permitted) return NOT_SHOWN;

  try {
    const banner = new Notification(params.title, {
      body: params.body ?? undefined,
      tag,
    });
    const { onClick } = params;
    if (onClick) {
      banner.onclick = () => {
        try {
          window.focus();
        } catch {
          // Some webviews refuse programmatic focus; the handler still runs.
        }
        onClick();
      };
    }
    if (tag === params.id) {
      askBanners.set(params.id, banner);
      banner.onclose = () => {
        if (askBanners.get(params.id) === banner) askBanners.delete(params.id);
      };
    }
    // The Web API can't pick a sound; the browser/OS plays its own.
    return { shown: true, sounded: true };
  } catch {
    // Silently ignore — Notification constructor can throw in some
    // restricted environments.
    return NOT_SHOWN;
  }
}

interface ShowParams {
  id: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  force?: boolean;
  sound?: ReminderSoundId | 'default';
  onClick?: () => void;
}

/**
 * Show an OS notification for an in-app notification, if its type is in
 * `OS_NOTIFICATION_TYPES` (failures, mentions, tool approvals). `force: true`
 * bypasses that gate for an alert the user asked for (the per-thread
 * run-ended alert). `sound` is what the native banner plays (the Web API
 * ignores it); `onClick` runs after the window is focused. Play the in-app
 * sound only when the outcome's `sounded` is false.
 */
export async function showOsNotification(params: ShowParams): Promise<OsNotificationOutcome> {
  if (!params.force && !OS_NOTIFICATION_TYPES.has(params.type)) return NOT_SHOWN;
  const tag = osNotificationTag(params);
  if (usesNativeBanners()) {
    const outcome = await showNative(params, tag);
    if (outcome) return outcome;
  }
  return showWeb(params, tag);
}

/**
 * Close the OS banner for a notification the server dismissed (its ask
 * settled), if one is still showing. No-op otherwise.
 */
export function closeOsNotification(id: string): void {
  nativeClickHandlers.delete(id);
  if (nativeAskIds.delete(id)) {
    recentNative.delete(id);
    void invokeShell<unknown>('notifications_close', { id }).catch((err: unknown) => {
      // The command is unavailable: nothing native to close.
      console.warn('[notifications] could not close a native banner', err);
    });
  }
  const banner = askBanners.get(id);
  if (!banner) return;
  askBanners.delete(id);
  try {
    banner.close();
  } catch {
    // Some webviews hand back a banner without a working close().
  }
}

export function __resetOsNotificationsForTests(): void {
  askBanners.clear();
  nativeAskIds.clear();
  nativeClickHandlers.clear();
  recentNative.clear();
  deniedNoticeShown = false;
  permissionRequested = false;
  clickListenerStarted = false;
}
