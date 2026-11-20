/**
 * The person's choice about an agent's flower (hidden with its ×, parked by dragging) lasts
 * one cursor session: from the agent's first cursor event until a `hidden` event or
 * CURSOR_SESSION_IDLE_MS without events, when every overlay drops the flower anyway. Every
 * cursor event carries the session id and the current choice; a change is also broadcast at
 * once (AGENT_CURSOR_FLOWER_EVENT) by the computer tool.
 *
 * It is also the server half of the click guard. Overlays let any flower take the mouse only
 * once no flower has moved for FLOWER_SETTLE_MS (and that flower's own settle time has
 * passed), so `needsHandoff` says when the computer tool must emit its event and wait
 * FLOWER_HANDOFF_MS before posting mouse input. It errs toward yes: overlays count from when
 * an event arrives, never earlier than the server sent it, and every flower zone is padded.
 */
import {
  CURSOR_SESSION_IDLE_MS,
  FLOWER_CORNER,
  FLOWER_GRIP,
  FLOWER_HANDOFF_MS,
  FLOWER_SETTLE_MS,
  flowerSettleMs,
  resetsFlowerSettle,
  type AgentCursorEvent,
  type AgentCursorFlowerEvent,
  type AgentCursorFlowerState,
} from '@snaglet/shared/constants/agentCursor';
import { generateId } from '@snaglet/shared/utils';
import { systemOverlayScreen, type OverlayScreen } from '@server/services/systemCursorOverlay';

/** A drag the overlay stops renewing releases the agent's input after this long. */
export const FLOWER_GRAB_MAX_MS = 10_000;
/** An overlay may hold a flower a little past the session's end (its prune runs each second). */
const SESSION_GRACE_MS = 5000;
/** Padding around every flower zone, for hand jitter and rounding between page and server. */
export const FLOWER_ZONE_MARGIN = 16;
/**
 * How long a flower that was taking the mouse may keep doing so after an event: delivery to
 * the page plus the native overlay's 100 ms page poll. Keep it under FLOWER_HANDOFF_MS.
 */
export const OVERLAY_LAG_MS = 300;

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Session {
  id: string;
  lastEventAt: number;
  /** When this flower last moved or changed state (emotion refreshes do not count). */
  settleFrom: number;
  settleMs: number;
  dismissedAt?: number;
  parkedAt?: Point;
  grabbedUntil?: number;
  /** Where an overlay may draw it: the latest event's point and the latest action's. */
  at: Point;
  actionAt: Point;
  /** The latest action left it waiting, which draws it in the bottom-right corner. */
  waiting: boolean;
  /** Its latest event went to the system-wide overlay, so the in-app one is not drawing it. */
  systemOverlay: boolean;
}

type FlowerFields = Pick<AgentCursorEvent, 'session' | 'dismissed' | 'parkedAt'>;
type EmitFields = Pick<
  AgentCursorEvent,
  'agentId' | 'state' | 'emotionUpdate' | 'glideMs' | 'x' | 'y' | 'systemOverlay'
>;

const inside = (p: Point, r: Rect) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

/** A flower's grip around its anchor, padded. */
function gripZone(anchor: Point, pad: number): Rect {
  return {
    x0: anchor.x + FLOWER_GRIP.left - pad,
    y0: anchor.y + FLOWER_GRIP.top - pad,
    x1: anchor.x + FLOWER_GRIP.right + pad,
    y1: anchor.y + FLOWER_GRIP.bottom + pad,
  };
}

/** The system overlay page clamps a flower's anchor to the display, like screenToViewport. */
function clampToScreen(p: Point, screen: OverlayScreen): Point {
  const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), Math.max(0, max));
  return { x: clamp(p.x, screen.width - 4), y: clamp(p.y, screen.height - 4) };
}

export class AgentCursorSessions {
  private sessions = new Map<string, Session>();
  /** No overlay lets any flower take the mouse before this (latest action + its settle time). */
  private settleUntil = Number.NEGATIVE_INFINITY;
  /** The last moment any flower could have been taking the mouse, as of the latest action. */
  private lastLiveAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => generateId('cursor'),
    private readonly screen: () => OverlayScreen | null = () => systemOverlayScreen()
  ) {}

  private live(agentId: string, now: number): Session | undefined {
    const s = this.sessions.get(agentId);
    return s && now - s.lastEventAt < CURSOR_SESSION_IDLE_MS ? s : undefined;
  }

  /** Forget sessions no overlay can still be drawing. */
  private sweep(now: number): void {
    for (const [id, s] of this.sessions) {
      if (now - s.lastEventAt >= CURSOR_SESSION_IDLE_MS + SESSION_GRACE_MS)
        this.sessions.delete(id);
    }
  }

  /** Whether any flower may be taking the mouse at `now` (dismissed long ago: no). */
  private anyMayBeLive(now: number): boolean {
    if (now < this.settleUntil) return false;
    for (const s of this.sessions.values()) {
      if (s.dismissedAt !== undefined && now - s.dismissedAt >= FLOWER_SETTLE_MS) continue;
      if (now >= s.settleFrom + s.settleMs) return true;
    }
    return false;
  }

  /** Record a cursor event that is about to be broadcast; returns the fields it must carry. */
  onEmit(event: EmitFields): FlowerFields {
    const now = this.now();
    this.sweep(now);
    if (resetsFlowerSettle(event)) {
      // A flower live until now stays live on an overlay for up to OVERLAY_LAG_MS more.
      if (this.anyMayBeLive(now)) this.lastLiveAt = now;
      this.settleUntil = Math.max(this.settleUntil, now + flowerSettleMs(event));
    }
    if (event.state === 'hidden') {
      this.sessions.delete(event.agentId);
      return {};
    }
    const at = { x: event.x, y: event.y };
    let s = this.live(event.agentId, now);
    if (!s) {
      s = {
        id: this.newId(),
        lastEventAt: now,
        settleFrom: now,
        settleMs: flowerSettleMs(event),
        at,
        actionAt: at,
        waiting: event.state === 'waiting',
        systemOverlay: event.systemOverlay === true,
      };
      this.sessions.set(event.agentId, s);
    }
    s.lastEventAt = now;
    s.at = at;
    s.systemOverlay = event.systemOverlay === true;
    if (resetsFlowerSettle(event)) {
      s.settleFrom = now;
      s.settleMs = flowerSettleMs(event);
      s.actionAt = at;
      s.waiting = event.state === 'waiting';
    }
    return {
      session: s.id,
      ...(s.dismissedAt !== undefined ? { dismissed: true as const } : {}),
      ...(s.parkedAt ? { parkedAt: { ...s.parkedAt } } : {}),
    };
  }

  private update(agentId: string, s: Session): AgentCursorFlowerEvent {
    return {
      agentId,
      session: s.id,
      dismissed: s.dismissedAt !== undefined,
      parkedAt: s.parkedAt ? { ...s.parkedAt } : null,
    };
  }

  /** The live session with this id, or undefined (no flower, or a later session). */
  private current(agentId: string, session: string, now: number): Session | undefined {
    const s = this.live(agentId, now);
    return s && s.id === session ? s : undefined;
  }

  /** Hide the flower for the rest of its session. Null when that session is not up. */
  dismiss(agentId: string, session: string): AgentCursorFlowerEvent | null {
    const now = this.now();
    const s = this.current(agentId, session, now);
    if (!s) return null;
    s.dismissedAt ??= now;
    s.grabbedUntil = undefined;
    return this.update(agentId, s);
  }

  /** Park the flower at a screen point for the rest of its session. */
  park(agentId: string, session: string, at: Point): AgentCursorFlowerEvent | null {
    const s = this.current(agentId, session, this.now());
    if (!s) return null;
    s.parkedAt = { x: at.x, y: at.y };
    s.grabbedUntil = undefined;
    return this.update(agentId, s);
  }

  /** The person pressed (held) or let go of (released) this flower without parking it. */
  grab(agentId: string, session: string, held: boolean): boolean {
    const now = this.now();
    const s = this.current(agentId, session, now);
    if (!s) return false;
    s.grabbedUntil = held ? now + FLOWER_GRAB_MAX_MS : undefined;
    return true;
  }

  /**
   * True while the person holds any flower: every agent's input waits, since a drag's
   * position is not known here and synthetic input would move the pointer out from under it.
   */
  anyGrabbed(): boolean {
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (s.grabbedUntil !== undefined && now < s.grabbedUntil) return true;
    }
    return false;
  }

  /**
   * Where an overlay may draw this flower's grip, padded. Null when unknown: the in-app
   * overlay may be drawing it (window geometry is not known here), or the system overlay
   * has not reported its display size.
   */
  private zones(s: Session, pad: number): Rect[] | null {
    const screen = this.screen();
    if (!s.systemOverlay || !screen) return null;
    if (s.parkedAt) return [gripZone(clampToScreen(s.parkedAt, screen), pad)];
    const out = [s.at, s.actionAt].map((p) => gripZone(clampToScreen(p, screen), pad));
    if (s.waiting) {
      // The page lines waiting flowers up by its own order; cover every slot it could use.
      const y = screen.height - FLOWER_CORNER.margin - FLOWER_CORNER.rise;
      const right = screen.width - FLOWER_CORNER.margin;
      const left = right - FLOWER_CORNER.spacing * Math.max(0, this.sessions.size - 1);
      out.push({ ...gripZone({ x: left, y }, pad), x1: gripZone({ x: right, y }, pad).x1 });
    }
    return out;
  }

  /**
   * Whether mouse input at these screen points must wait FLOWER_HANDOFF_MS: some flower may
   * be taking the mouse now or within the wait, and its grip may cover one of the points.
   * `points` null (input at an unknown spot) waits whenever any flower may be live.
   */
  needsHandoff(points: Point[] | null): boolean {
    const now = this.now();
    this.sweep(now);
    // An action just held a flower that was live: an overlay may lag behind, and the flower
    // may have moved since, so wait wherever the input lands.
    if (now - this.lastLiveAt <= OVERLAY_LAG_MS) return true;
    if (now + FLOWER_HANDOFF_MS < this.settleUntil) return false;
    for (const s of this.sessions.values()) {
      if (s.dismissedAt !== undefined && now - s.dismissedAt >= FLOWER_SETTLE_MS) continue;
      if (now + FLOWER_HANDOFF_MS < s.settleFrom + s.settleMs) continue;
      if (!points) return true;
      const zones = this.zones(s, FLOWER_ZONE_MARGIN);
      if (!zones || points.some((p) => zones.some((z) => inside(p, z)))) return true;
    }
    return false;
  }

  /**
   * Where a flower's grip may be, for telling whether the person's pointer is on it. Where the
   * geometry is unknown the anchor is taken as drawn unclamped, which is where the in-app
   * overlay draws it inside the Snaglet window.
   */
  private reachZones(s: Session): Rect[] {
    return (
      this.zones(s, FLOWER_ZONE_MARGIN) ?? [
        gripZone(s.parkedAt ?? s.at, FLOWER_ZONE_MARGIN),
        gripZone(s.parkedAt ?? s.actionAt, FLOWER_ZONE_MARGIN),
      ]
    );
  }

  /**
   * Whether a screen point is on (or just around) a shown flower: the person is reaching for
   * its × or about to drag it.
   */
  pointerOnFlower(p: Point): boolean {
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (now - s.lastEventAt >= CURSOR_SESSION_IDLE_MS || s.dismissedAt !== undefined) continue;
      if (this.reachZones(s).some((z) => inside(p, z))) return true;
    }
    return false;
  }

  /**
   * Whether the person's pointer was on this flower when they hid or parked it: on its grip
   * (where it was, or where it is being parked), or anywhere if they had pressed it and
   * dragged it away. Ask before applying the choice, which ends the hold.
   */
  reachedFlower(agentId: string, session: string, p: Point, parkAt?: Point): boolean {
    const now = this.now();
    const s = this.current(agentId, session, now);
    if (!s) return false;
    if (s.grabbedUntil !== undefined && now < s.grabbedUntil) return true;
    const zones = this.reachZones(s);
    if (parkAt) zones.push(gripZone(parkAt, FLOWER_ZONE_MARGIN));
    return zones.some((z) => inside(p, z));
  }

  /** Every session an overlay may still be drawing, for a resync after a lost connection. */
  snapshot(): AgentCursorFlowerState[] {
    const now = this.now();
    this.sweep(now);
    return [...this.sessions.entries()]
      .filter(([, s]) => now - s.lastEventAt < CURSOR_SESSION_IDLE_MS)
      .map(([agentId, s]) => ({ ...this.update(agentId, s), systemOverlay: s.systemOverlay }));
  }

  /** Test hook. */
  reset(): void {
    this.sessions.clear();
    this.settleUntil = Number.NEGATIVE_INFINITY;
    this.lastLiveAt = Number.NEGATIVE_INFINITY;
  }
}

export const agentCursorSessions = new AgentCursorSessions();
