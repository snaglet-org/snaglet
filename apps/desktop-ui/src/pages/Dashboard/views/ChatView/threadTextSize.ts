/**
 * Per-thread chat text size: a view preference, kept per device.
 *
 * A thread reads at Small (the default), Medium, Large or Extra large. The
 * choice is stored in localStorage, one key per thread, and applied by
 * overriding `--chat-text-base` on that thread's chat column, so its message
 * bodies, their markdown headings and tables (sized in em) and the composer
 * follow it while every other thread keeps its own size. Nothing goes to the
 * server: it changes how this client paints one thread, never what an agent
 * sees.
 *
 * Same external-store shape as utils/displayPrefs.ts (module state, a
 * listener set, useSyncExternalStore), so the settings control and the open
 * chat update together.
 */

import { useCallback, useSyncExternalStore, type CSSProperties } from 'react';

export const THREAD_TEXT_SIZES = ['small', 'medium', 'large', 'xlarge'] as const;
type ThreadTextSize = (typeof THREAD_TEXT_SIZES)[number];

const DEFAULT_THREAD_TEXT_SIZE: ThreadTextSize = 'small';

export const THREAD_TEXT_SIZE_LABELS: Record<ThreadTextSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  xlarge: 'Extra large',
};

/**
 * Chat body size for each choice, in px. Small mirrors `--chat-text-base` in
 * packages/ui/styles/_tokens.scss.
 */
const THREAD_TEXT_PX: Record<ThreadTextSize, number> = {
  small: 14,
  medium: 15.5,
  large: 17,
  xlarge: 19,
};

const KEY_PREFIX = 'snaglet.dashboard.chat.textSize.';

/** The localStorage key holding one thread's size. */
function threadTextSizeKey(threadId: string): string {
  return KEY_PREFIX + threadId;
}

export function isThreadTextSize(value: unknown): value is ThreadTextSize {
  return typeof value === 'string' && (THREAD_TEXT_SIZES as readonly string[]).includes(value);
}

/** Sizes chosen this session; they apply even when localStorage is blocked. */
const chosen = new Map<string, ThreadTextSize>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readStored(threadId: string): ThreadTextSize {
  if (typeof window === 'undefined') return DEFAULT_THREAD_TEXT_SIZE;
  try {
    const stored = window.localStorage.getItem(threadTextSizeKey(threadId));
    return isThreadTextSize(stored) ? stored : DEFAULT_THREAD_TEXT_SIZE;
  } catch {
    return DEFAULT_THREAD_TEXT_SIZE;
  }
}

/** A thread's size without subscribing. Unknown or invalid stored values read as Small. */
function getThreadTextSize(threadId: string): ThreadTextSize {
  if (!threadId) return DEFAULT_THREAD_TEXT_SIZE;
  return chosen.get(threadId) ?? readStored(threadId);
}

/**
 * Set a thread's size. Applies live to every subscriber, then persists
 * best-effort; Small removes the key, so only threads that differ from the
 * default keep one.
 */
export function setThreadTextSize(threadId: string, size: ThreadTextSize): void {
  if (!threadId || !isThreadTextSize(size) || size === getThreadTextSize(threadId)) return;
  chosen.set(threadId, size);
  try {
    if (size === DEFAULT_THREAD_TEXT_SIZE) {
      window.localStorage.removeItem(threadTextSizeKey(threadId));
    } else {
      window.localStorage.setItem(threadTextSizeKey(threadId), size);
    }
  } catch {
    // Persistence is best-effort; the in-memory value already applied.
  }
  for (const listener of listeners) listener();
}

/** The chosen text size of one thread, live. */
export function useThreadTextSize(threadId: string): ThreadTextSize {
  const getSnapshot = useCallback(() => getThreadTextSize(threadId), [threadId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Inline style for a thread's chat column: overrides `--chat-text-base` for
 * every size but Small, which keeps the token's own default.
 */
export function threadTextSizeStyle(size: ThreadTextSize): CSSProperties | undefined {
  if (size === DEFAULT_THREAD_TEXT_SIZE) return undefined;
  return {
    '--chat-text-base': `${THREAD_TEXT_PX[size]}px`,
  } as CSSProperties;
}
