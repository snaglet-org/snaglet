/**
 * Display preferences — module-level reactive store for user-facing display
 * toggles, persisted to localStorage so they survive reloads.
 *
 * Same external-store pattern as `notificationState.ts` (module state +
 * subscriber set + `useSyncExternalStore`) and the same `snaglet.dashboard.*` key
 * family as other display choices. A client store, not a server setting:
 * these change how one client paints data it already has, never what an
 * agent or the server does.
 */

import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SHOW_AGENT_POPUPS_KEY = 'snaglet.dashboard.agentPopups.show';

function readStoredShowAgentPopups(): boolean {
  // Default ON: popups show unless the stored value is exactly 'false', so an
  // agent's question is never silently missed.
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(SHOW_AGENT_POPUPS_KEY) !== 'false';
  } catch {
    return true;
  }
}

let showAgentPopups = readStoredShowAgentPopups();

/** Current value without subscribing — for non-React callers and snapshots. */
export function getShowAgentPopups(): boolean {
  return showAgentPopups;
}

/** Flip the preference. Applies live to every subscribed surface, then
 *  persists best-effort — a blocked localStorage still flips this session. */
export function setShowAgentPopups(value: boolean): void {
  if (value === showAgentPopups) return;
  showAgentPopups = value;
  try {
    window.localStorage.setItem(SHOW_AGENT_POPUPS_KEY, value ? 'true' : 'false');
  } catch {
    // Persistence is best-effort; the in-memory value already applied.
  }
  notify();
}

/** Whether a question or permission request from a chat that is not on screen pops
 *  up with the agent's avatar. Default on. */
export function useShowAgentPopups(): boolean {
  return useSyncExternalStore(subscribe, getShowAgentPopups, getShowAgentPopups);
}

const CHAT_AUTO_SCROLL_KEY = 'snaglet.dashboard.chat.autoScroll';

function readStoredChatAutoScroll(): boolean {
  // Default ON: only the exact string 'false' turns it off.
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(CHAT_AUTO_SCROLL_KEY) !== 'false';
  } catch {
    return true;
  }
}

let chatAutoScroll = readStoredChatAutoScroll();

function getChatAutoScroll(): boolean {
  return chatAutoScroll;
}

/** Flip the preference. Applies live, then persists best-effort. */
export function setChatAutoScroll(value: boolean): void {
  if (value === chatAutoScroll) return;
  chatAutoScroll = value;
  try {
    window.localStorage.setItem(CHAT_AUTO_SCROLL_KEY, value ? 'true' : 'false');
  } catch {
    // Persistence is best-effort; the in-memory value already applied.
  }
  notify();
}

/** Whether a thread follows new output to the bottom (auto) or stays where the
 *  reader left it (manual). Default on. */
export function useChatAutoScroll(): boolean {
  return useSyncExternalStore(subscribe, getChatAutoScroll, getChatAutoScroll);
}
