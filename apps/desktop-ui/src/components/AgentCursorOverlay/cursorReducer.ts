import type { EmotionId } from '@snaglet/shared/cursor';
import {
  CURSOR_SESSION_IDLE_MS,
  FLOWER_SETTLE_MS,
  flowerSettleMs,
  resetsFlowerSettle,
  type AgentCursorEvent,
  type AgentCursorFlowerEvent,
  type AgentCursorFlowerState,
} from '@snaglet/shared/constants/agentCursor';

// A flower sitting still through narration or a handoff must not vanish, but it goes when
// the server's cursor session for it ends.
const CURSOR_IDLE_TIMEOUT_MS = CURSOR_SESSION_IDLE_MS;
/** How long an event's emotion stays on the avatar before it reverts to neutral. */
export const CURSOR_EMOTION_MS = 3500;

interface FaceEntry {
  event: AgentCursorEvent;
  /** Epoch ms of the last event for this agent. */
  seenAt: number;
  /** Face to draw; set by an event carrying `emotion`, expires after CURSOR_EMOTION_MS. */
  emotion?: EmotionId;
  /** Epoch ms of the event that carried `emotion`. */
  emotionAt?: number;
  /**
   * True while `event` (its label/state) was supplied by an emotion emission
   * (CursorEmotionService `start`/`renew`) rather than an action. Any other event
   * replaces `event` and drops ownership; a settle only clears owned events.
   */
  emotionOwned?: boolean;
}

interface FlowerEntry {
  /** Epoch ms since which the flower has stayed still; it takes the mouse `settleMs` later. */
  settledFrom: number;
  settleMs: number;
  /** Epoch ms of the last event from the server (an open question does not refresh it). */
  lastEventAt: number;
  /** Server cursor session; the person's choices below last for one session. */
  session?: string;
  /** Hidden by the person (its × or dragged off the edge). The agent keeps working. */
  dismissed?: boolean;
  /** Where the person parked the flower (screen points); it no longer follows the pointer. */
  parkedAt?: { x: number; y: number };
}

type CursorEntry = FaceEntry & FlowerEntry;

export type CursorMap = Record<string, CursorEntry>;

function reduceFace(
  prev: CursorEntry | undefined,
  event: AgentCursorEvent,
  now: number
): FaceEntry {
  if (event.emotion === 'neutral') {
    // A settlement clears the face. It clears the narration only while the visible
    // event is still the emotion's own; if an action spoke since, that action stays.
    if (event.emotionUpdate === 'settle' && prev && !prev.emotionOwned) {
      return { event: prev.event, seenAt: now };
    }
    // Explicit reset: drop the held face now instead of waiting out CURSOR_EMOTION_MS.
    return { event, seenAt: now };
  }
  if (event.emotion) {
    // Renewals keep the face alive but never replay their narration over a newer
    // action. With no prior entry (or one the emotion owns) they still show it.
    const owns = event.emotionUpdate === 'start' || event.emotionUpdate === 'renew';
    const keepPrev = event.emotionUpdate === 'renew' && prev && !prev.emotionOwned;
    return {
      event: keepPrev ? prev.event : event,
      seenAt: now,
      emotion: event.emotion,
      emotionAt: now,
      ...(owns && !keepPrev ? { emotionOwned: true } : {}),
    };
  }
  // No emotion on this event: keep a fresh one unless this is a new action (click/move/drag).
  const newAction = event.state === 'click' || event.state === 'move' || event.state === 'drag';
  const keep = prev?.emotion && !newAction && now - (prev.emotionAt ?? 0) < CURSOR_EMOTION_MS;
  return keep
    ? { event, seenAt: now, emotion: prev.emotion, emotionAt: prev.emotionAt }
    : { event, seenAt: now };
}

/**
 * The flower's settle clock and the person's choices. A new session starts the flower
 * fresh: it must settle again (never earlier than the server's clock for that session) and
 * forgets the last session's choices. Within a session a local choice wins over the copy an
 * event carries, which may predate it.
 */
function reduceFlower(
  prev: CursorEntry | undefined,
  event: AgentCursorEvent,
  now: number
): FlowerEntry {
  const same = prev !== undefined && prev.session === event.session;
  const restart = !same || resetsFlowerSettle(event);
  const parkedAt = (same ? prev.parkedAt : undefined) ?? event.parkedAt;
  return {
    settledFrom: restart ? now : prev.settledFrom,
    settleMs: restart ? flowerSettleMs(event) : prev.settleMs,
    lastEventAt: now,
    ...(event.session !== undefined ? { session: event.session } : {}),
    ...(event.dismissed === true || (same && prev.dismissed) ? { dismissed: true } : {}),
    ...(parkedAt ? { parkedAt } : {}),
  };
}

/** Fold an incoming event into the per-agent map: 'hidden' removes the agent. */
export function reduceCursorEvent(map: CursorMap, event: AgentCursorEvent, now: number): CursorMap {
  if (event.state === 'hidden') {
    if (!(event.agentId in map)) return map;
    const { [event.agentId]: _removed, ...rest } = map;
    return rest;
  }
  const prev = map[event.agentId];
  return {
    ...map,
    [event.agentId]: { ...reduceFace(prev, event, now), ...reduceFlower(prev, event, now) },
  };
}

/** Apply a hide/park the server broadcast; ignored for another session or an unknown agent. */
export function applyFlowerUpdate(map: CursorMap, update: AgentCursorFlowerEvent): CursorMap {
  const prev = map[update.agentId];
  if (!prev || prev.session !== update.session) return map;
  const parkedAt = update.parkedAt ?? prev.parkedAt;
  return {
    ...map,
    [update.agentId]: {
      ...prev,
      ...(update.dismissed || prev.dismissed ? { dismissed: true } : {}),
      ...(parkedAt ? { parkedAt } : {}),
    },
  };
}

/** The person hid this flower here; the server is told separately. */
export function dismissFlower(map: CursorMap, agentId: string): CursorMap {
  const prev = map[agentId];
  return prev && !prev.dismissed ? { ...map, [agentId]: { ...prev, dismissed: true } } : map;
}

/** The person dropped this flower at a screen point; the server is told separately. */
export function parkFlower(
  map: CursorMap,
  agentId: string,
  at: { x: number; y: number }
): CursorMap {
  const prev = map[agentId];
  return prev ? { ...map, [agentId]: { ...prev, parkedAt: { x: at.x, y: at.y } } } : map;
}

/**
 * When no flower may take the mouse before, after this event: any agent's action holds every
 * flower click-through for its settle time, so a still flower is never under another agent's
 * next click. Emotion refreshes leave it alone.
 */
export function nextSettleUntil(settleUntil: number, event: AgentCursorEvent, now: number): number {
  return resetsFlowerSettle(event)
    ? Math.max(settleUntil, now + flowerSettleMs(event))
    : settleUntil;
}

/** After a lost connection the overlay may have missed actions: hold every flower again. */
export function settleAfterReconnect(settleUntil: number, now: number): number {
  return Math.max(settleUntil, now + FLOWER_SETTLE_MS);
}

/**
 * Whether the flower may take the mouse now: shown, its session still alive, still for its own
 * settle time, and no flower has moved within the global settle window (`settleUntil`). Any new
 * action event, from any agent, turns this off at once, before the server posts the input.
 */
export function isFlowerInteractive(entry: CursorEntry, now: number, settleUntil = 0): boolean {
  return (
    !entry.dismissed &&
    now - entry.lastEventAt < CURSOR_SESSION_IDLE_MS &&
    now >= entry.settledFrom + entry.settleMs &&
    now >= settleUntil
  );
}

/** Epoch ms when a not-yet-settled flower will take the mouse, or null. */
export function nextSettleAt(map: CursorMap, now: number, settleUntil = 0): number | null {
  let next: number | null = null;
  for (const entry of Object.values(map)) {
    const at = Math.max(entry.settledFrom + entry.settleMs, settleUntil);
    if (!entry.dismissed && at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * Bring the map in line with the server after a lost connection: drop flowers whose session
 * ended (or, in the app window, moved to the system overlay) and take each live session's
 * hide/park choice. A hide made here stays even if the server never heard of it.
 */
export function applyFlowerSnapshot(
  map: CursorMap,
  flowers: AgentCursorFlowerState[],
  standalone: boolean
): CursorMap {
  const next: CursorMap = {};
  for (const [id, entry] of Object.entries(map)) {
    const live = flowers.find((f) => f.agentId === id && f.session === entry.session);
    if (!live || (!standalone && live.systemOverlay)) continue;
    const parkedAt = live.parkedAt ?? entry.parkedAt;
    next[id] = {
      ...entry,
      ...(live.dismissed || entry.dismissed ? { dismissed: true } : {}),
      ...(parkedAt ? { parkedAt } : {}),
    };
  }
  return next;
}

/** Drop agents with no events for `timeoutMs`. Returns the same map if unchanged. */
export function pruneStaleCursors(
  map: CursorMap,
  now: number,
  timeoutMs: number = CURSOR_IDLE_TIMEOUT_MS
): CursorMap {
  let changed = false;
  const next: CursorMap = {};
  for (const [id, entry] of Object.entries(map)) {
    if (now - entry.seenAt >= timeoutMs) changed = true;
    else if (entry.emotion && now - (entry.emotionAt ?? 0) >= CURSOR_EMOTION_MS) {
      changed = true;
      const { emotion: _emotion, emotionAt: _emotionAt, ...rest } = entry;
      next[id] = rest;
    } else next[id] = entry;
  }
  return changed ? next : map;
}

export interface Viewport {
  screenX: number;
  screenY: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
}

/** Map a screen-pixel point into viewport coordinates, clamped inside it. */
export function screenToViewport(x: number, y: number, v: Viewport): { x: number; y: number } {
  const chrome = Math.max(0, v.outerHeight - v.innerHeight);
  const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), Math.max(0, max));
  return {
    x: clamp(x - v.screenX, v.innerWidth - 4),
    y: clamp(y - v.screenY - chrome, v.innerHeight - 4),
  };
}

/** Inverse of screenToViewport (without the clamp). */
export function viewportToScreen(x: number, y: number, v: Viewport): { x: number; y: number } {
  const chrome = Math.max(0, v.outerHeight - v.innerHeight);
  return { x: x + v.screenX, y: y + v.screenY + chrome };
}

export function isAgentCursorFlowerState(value: unknown): value is AgentCursorFlowerState {
  return (
    isAgentCursorFlowerEvent(value) &&
    typeof (value as unknown as Record<string, unknown>).systemOverlay === 'boolean'
  );
}

export function isAgentCursorFlowerEvent(value: unknown): value is AgentCursorFlowerEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const at = v.parkedAt as Record<string, unknown> | null | undefined;
  return (
    typeof v.agentId === 'string' &&
    typeof v.session === 'string' &&
    typeof v.dismissed === 'boolean' &&
    (at === null || (!!at && typeof at.x === 'number' && typeof at.y === 'number'))
  );
}

export function isAgentCursorEvent(value: unknown): value is AgentCursorEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.agentId === 'string' &&
    typeof v.state === 'string' &&
    typeof v.x === 'number' &&
    typeof v.y === 'number'
  );
}
