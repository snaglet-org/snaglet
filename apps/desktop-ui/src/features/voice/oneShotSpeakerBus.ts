// Tiny EventTarget bus tracking which one message (if any) is playing a
// per-message re-listen clip (BubbleActions' listen button). The state is a
// module singleton so every message row agrees on the current speaker and a
// second click, on this message or another, stops whatever is playing.

import type { OneShotHandle } from './audio/playOneShot';

const BUS_EVENT = 'snaglet:voice:oneshot:speaker';

let speakerId: string | null = null;
let speakerHandle: OneShotHandle | null = null;

function broadcast(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string | null>(BUS_EVENT, { detail: speakerId }));
}

/** The messageId currently speaking a one-shot clip, or null. */
export function getSpeakerId(): string | null {
  return speakerId;
}

/** Stop whichever clip is currently playing. No-op if none is. */
export function stopSpeaker(): void {
  if (!speakerHandle) return;
  const handle = speakerHandle;
  speakerId = null;
  speakerHandle = null;
  handle.stop(); // fires that clip's onEnded (its own cleanup) — harmless here
  broadcast();
}

/**
 * Claim the single speaking slot for `messageId`, stopping whoever else held
 * it. Re-claiming the same messageId (e.g. upgrading a reservation to the
 * real handle once playback starts) replaces the handle without stopping it.
 */
export function claimSpeaker(messageId: string, handle: OneShotHandle): void {
  if (speakerId !== messageId) stopSpeaker();
  speakerId = messageId;
  speakerHandle = handle;
  broadcast();
}

/**
 * Release the slot when `messageId`'s clip ends naturally. No-op if another
 * message has since claimed the slot — a late callback must never clobber a
 * newer claim.
 */
export function releaseSpeaker(messageId: string): void {
  if (speakerId !== messageId) return;
  speakerId = null;
  speakerHandle = null;
  broadcast();
}

/** Notified with the new speakerId (or null) on every claim/stop/release. */
export function subscribeSpeaker(handler: (speakingId: string | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<string | null>).detail);
  window.addEventListener(BUS_EVENT, listener);
  return () => window.removeEventListener(BUS_EVENT, listener);
}

/**
 * Test-only: clear the module-singleton state without invoking a stale
 * handle's `stop()` (mirrors engineAdapter's `__setVoiceEngineForTest`).
 * Prevents one test's leftover speaker from leaking into the next.
 */
export function __resetSpeakerForTest(): void {
  speakerId = null;
  speakerHandle = null;
}
