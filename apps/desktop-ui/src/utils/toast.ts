/**
 * Minimal global toast bus.
 *
 * Surfaces fire `showToast('Task ID copied')` from any callback; a single
 * `<ToastHost />` mounted at the app root listens for the custom event and
 * renders the queue. Keeps the API stateless so callers don't need to plumb
 * a context — useful for deep-tree callbacks like a tree-row context menu.
 *
 * A toast may carry one action (`{ label: 'Undo', run }`). The host keeps an
 * action toast on screen while it is hovered or focused, makes the button
 * reachable with Tab, dismisses the focused toast on Escape, and runs the
 * action at most once.
 */

const TOAST_EVENT = 'snaglet:toast';

export interface ToastAction {
  /** Button text, e.g. "Undo". */
  label: string;
  /** Called at most once, when the user presses the button. */
  run: () => void;
}

export interface ToastDetail {
  /** Caller's id, so `dismissToast(id)` can close it early. */
  id?: string;
  message: string;
  durationMs: number;
  action?: ToastAction;
}

export interface ShowToastOptions {
  /** Lets `dismissToast(id)` close this toast before its timer. */
  id?: string;
  durationMs?: number;
  action?: ToastAction;
}

/** How long a toast with an action stays when the caller does not say. */
export const ACTION_TOAST_DURATION_MS = 6000;

export function showToast(message: string, opts?: ShowToastOptions): void {
  if (typeof window === 'undefined') return;
  const detail: ToastDetail = {
    ...(opts?.id ? { id: opts.id } : {}),
    message,
    durationMs: opts?.durationMs ?? (opts?.action ? ACTION_TOAST_DURATION_MS : 1800),
    ...(opts?.action ? { action: opts.action } : {}),
  };
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail }));
}

export const TOAST_EVENT_NAME = TOAST_EVENT;

const TOAST_DISMISS_EVENT = 'snaglet:toast-dismiss';
export const TOAST_DISMISS_EVENT_NAME = TOAST_DISMISS_EVENT;

/** Close every shown toast that was opened with `{ id }`; a no-op when none is. */
export function dismissToast(id: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ id: string }>(TOAST_DISMISS_EVENT, { detail: { id } }));
}
