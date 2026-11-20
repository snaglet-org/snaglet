/**
 * Agent cursor — the flower each agent's `computer` cursor is drawn as.
 * Shared by the server tool (which emits cursor events), the agent settings
 * picker and the cursor overlay, so all three agree on ids and defaults.
 */

import type { EmotionId } from '../cursor/emotions';

export const CURSOR_FLOWERS = [
  'blossom',
  'daisy',
  'tulip',
  'sunflower',
  'rose',
  'lavender',
  'cherry-blossom',
  'lotus',
  'poppy',
] as const;

export type CursorFlower = (typeof CURSOR_FLOWERS)[number];

export const CURSOR_FLOWER_COLORS: Record<CursorFlower, string> = {
  blossom: '#FF9EC7',
  daisy: '#f5f0e6',
  tulip: '#ef5d8a',
  sunflower: '#f6b81a',
  rose: '#d93b4a',
  lavender: '#9a7fd1',
  'cherry-blossom': '#f7a8c4',
  lotus: '#f08bd0',
  poppy: '#f2562b',
};

export function isCursorFlower(value: unknown): value is CursorFlower {
  return typeof value === 'string' && (CURSOR_FLOWERS as readonly string[]).includes(value);
}

/** Every agent without a pick gets the pink blossom. */
export const DEFAULT_CURSOR_FLOWER: CursorFlower = 'blossom';

export function defaultCursorFlower(_agentId?: string): CursorFlower {
  return DEFAULT_CURSOR_FLOWER;
}

/** Click-ring color: a lighter pink on the default blossom, else the flower color. */
export function clickRingColor(flower: CursorFlower, color: string): string {
  return flower === 'blossom' && color.toLowerCase() === CURSOR_FLOWER_COLORS.blossom.toLowerCase()
    ? BLOSSOM_RING
    : color;
}

export const CURSOR_HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Petal outline of the default pink blossom, and the yellow center every blossom keeps. */
export const BLOSSOM_DEFAULT_OUTLINE = '#EE669E';
export const BLOSSOM_CENTER = { fill: '#FFD940', outline: '#CC8C1A' } as const;
/** Click-ring color of the default blossom. */
export const BLOSSOM_RING = '#FF8CB3';

/**
 * Darker shade of a #rrggbb color: each channel is scaled by (1 - amount),
 * amount clamped to 0..1. Anything that is not #rrggbb is returned unchanged.
 */
export function darken(hex: string, amount: number): string {
  if (!CURSOR_HEX_COLOR.test(hex)) return hex;
  const k = 1 - Math.min(1, Math.max(0, amount));
  const channel = (i: number) =>
    Math.round(parseInt(hex.slice(i, i + 2), 16) * k)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** Outline for a blossom petal: its own outline on the default pink, else a darker shade. */
export function blossomOutline(color: string): string {
  return color.toLowerCase() === CURSOR_FLOWER_COLORS.blossom.toLowerCase()
    ? BLOSSOM_DEFAULT_OUTLINE
    : darken(color, 0.25);
}

export interface ResolvedAgentCursor {
  flower: CursorFlower;
  color: string;
}

export function resolveAgentCursor(
  agentId: string,
  flower?: string | null,
  color?: string | null
): ResolvedAgentCursor {
  const resolved = isCursorFlower(flower) ? flower : defaultCursorFlower(agentId);
  return { flower: resolved, color: color || CURSOR_FLOWER_COLORS[resolved] };
}

export type AgentCursorState = 'idle' | 'move' | 'click' | 'drag' | 'waiting' | 'hidden';

/**
 * Realtime event the server broadcasts so the overlay can draw an agent's
 * cursor. Coordinates are screen pixels (top-left origin, logical points).
 */
export interface AgentCursorEvent {
  agentId: string;
  name: string;
  flower: CursorFlower;
  color: string;
  state: AgentCursorState;
  x: number;
  y: number;
  /** One-line reason shown beside the flower. */
  label?: string;
  /** Who holds the real cursor right now (agent id), or null when free. */
  holderAgentId: string | null;
  /** True while the system-wide overlay is running; the in-app overlay then stands down. */
  systemOverlay?: boolean;
  /** Face to show while the event is fresh (the overlay reverts to neutral after ~3.5s). */
  emotion?: EmotionId;
  /**
   * Set only by CursorEmotionService emissions (never by action events); tells the
   * renderer who owns the visible label. `start` supplies the narration (e.g. an Ask's
   * question) and takes ownership of it; `renew` refreshes the face without replacing
   * a newer action event; `settle` clears the face and clears the narration only while
   * it is still owned by the emotion.
   */
  emotionUpdate?: 'start' | 'renew' | 'settle';
  /** One-shot visual animation; never moves the real pointer. */
  animation?: AvatarEmote;
  animationId?: string;
  /** Visual glide for this move, in ms, with linear easing (scripted choreography). Absent = default ease. */
  glideMs?: number;
  /** Cursor session this event belongs to; the person's hide/park choice lasts one session. */
  session?: string;
  /** The person hid this flower for the rest of the session (its × or dragged off the edge). */
  dismissed?: true;
  /** The person parked this flower here (screen points, like x/y); it stops following the pointer. */
  parkedAt?: { x: number; y: number };
}

export const AGENT_CURSOR_EVENT = 'agent:cursor';

/**
 * Broadcast when the person hides or parks a flower, so every overlay (the in-app one and
 * the system-wide page) applies it at once. Later cursor events of the same session carry
 * the same choice, so an overlay that opens mid-session still applies it.
 */
export const AGENT_CURSOR_FLOWER_EVENT = 'agent:cursor-flower';

export interface AgentCursorFlowerEvent {
  agentId: string;
  session: string;
  dismissed: boolean;
  parkedAt: { x: number; y: number } | null;
}

/** One live session's choice, as GET /api/computer/cursor/flowers lists it for a resync. */
export interface AgentCursorFlowerState extends AgentCursorFlowerEvent {
  /** The session's last event went to the system-wide overlay (the in-app one stands down). */
  systemOverlay: boolean;
}

/**
 * A cursor session ends after this long without an event for the agent, and every overlay
 * drops the flower then. A flower never takes the mouse once its last event is this old.
 */
export const CURSOR_SESSION_IDLE_MS = 120_000;

/**
 * Every flower takes the mouse (hover ×, drag) only once no flower has moved for this long:
 * one agent's action makes all flowers click-through, so a still flower is never under
 * another agent's next click, and a flower still gliding or left behind by a jump never
 * sits under its own agent's.
 */
export const FLOWER_SETTLE_MS = 1000;

/**
 * The part of a flower that takes the mouse, relative to its anchor (the click point), in
 * px (= screen points): the 80 px avatar box, which starts 62 up-left of the anchor, cut
 * off 8 px above the anchor so it never covers the spot the agent clicks. The × sits in its
 * top-right corner. The overlays draw it from these numbers and the server mirrors them.
 */
export const FLOWER_GRIP = { left: -62, top: -62, right: 18, bottom: -8 } as const;

/** Waiting flowers line up from the bottom-right corner (anchor positions, px). */
export const FLOWER_CORNER = { margin: 28, spacing: 36, rise: 40 } as const;

/**
 * Before posting mouse input while a flower may be taking the mouse at that point, the
 * server emits the cursor event and waits this long, so every overlay (including the native
 * overlay's 100 ms page poll) has made every flower click-through again. Keep it well under
 * FLOWER_SETTLE_MS.
 */
export const FLOWER_HANDOFF_MS = 400;

/** How long an event's flower must stay still before it takes the mouse: settle time plus its glide. */
export function flowerSettleMs(event: Pick<AgentCursorEvent, 'glideMs'>): number {
  const glide = Number.isFinite(event.glideMs) ? Math.max(0, event.glideMs as number) : 0;
  return FLOWER_SETTLE_MS + glide;
}

/**
 * Whether an event restarts the flower's settle time. Every event does except the
 * emotion service's face refreshes, which keep the flower where it is and never come
 * before input.
 */
export function resetsFlowerSettle(event: Pick<AgentCursorEvent, 'emotionUpdate'>): boolean {
  return !event.emotionUpdate;
}

/**
 * Cursor approval — before an agent's first `claim` the user is asked in the
 * app. The server broadcasts a request, the app answers over HTTP
 * (POST /api/computer/approval), and the server broadcasts the resolution.
 */
export const AGENT_CURSOR_REQUEST_EVENT = 'agent:cursor-request';
export const AGENT_CURSOR_REQUEST_RESOLVED_EVENT = 'agent:cursor-request-resolved';

export type CursorApprovalDecision = 'allow' | 'allow-session' | 'deny';

export interface AgentCursorRequestEvent {
  requestId: string;
  /** What is being approved. Absent means the desktop cursor. */
  kind?: 'cursor' | 'browser' | 'handoff';
  /** For kind 'handoff': `reason` is the step the user should finish in the browser window. */
  /** For kind 'browser': the browser profile the agent wants to use. */
  profile?: string;
  agentId: string;
  name: string;
  flower: CursorFlower;
  color: string;
  reason?: string;
  /** Epoch ms after which the request times out and the agent is told no answer came. */
  expiresAt: number;
}

export interface AgentCursorRequestResolvedEvent {
  requestId: string;
  decision: CursorApprovalDecision | 'timeout';
}

export const AVATAR_EMOTES = ['spin', 'hyper', 'laugh', 'cry', 'celebrate', 'angry'] as const;
export type AvatarEmote = (typeof AVATAR_EMOTES)[number];
