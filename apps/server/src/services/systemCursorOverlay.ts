/**
 * Tracks whether the system-wide cursor overlay (the native window that draws
 * agent flowers over the whole desktop) is running. Its page pings a heartbeat;
 * while one is fresh the in-app overlay stands down so a flower is not drawn twice.
 */
export const HEARTBEAT_TTL_MS = 10_000;

let lastSeenAt = Number.NEGATIVE_INFINITY;

export interface OverlayScreen {
  width: number;
  height: number;
}

let screen: OverlayScreen | null = null;

/** The page reports the main display's size (points) so the server can place its flowers. */
export function markSystemOverlayAlive(
  now: number = Date.now(),
  size: OverlayScreen | null = null
): void {
  lastSeenAt = now;
  screen = size;
}

export function isSystemOverlayActive(now: number = Date.now()): boolean {
  return now - lastSeenAt < HEARTBEAT_TTL_MS;
}

/** The running system overlay's display size, or null when it is not running or did not say. */
export function systemOverlayScreen(now: number = Date.now()): OverlayScreen | null {
  return isSystemOverlayActive(now) ? screen : null;
}

/** Test hook. */
export function resetSystemOverlay(): void {
  lastSeenAt = Number.NEGATIVE_INFINITY;
  screen = null;
}

// The ask window (native, interactive; shows pending agent questions and permission
// prompts) heartbeats separately so the in-app pop-ups stand down while it runs.
let askWindowLastSeenAt = Number.NEGATIVE_INFINITY;

export function markAskWindowAlive(now: number = Date.now()): void {
  askWindowLastSeenAt = now;
}

export function isAskWindowActive(now: number = Date.now()): boolean {
  return now - askWindowLastSeenAt < HEARTBEAT_TTL_MS;
}
