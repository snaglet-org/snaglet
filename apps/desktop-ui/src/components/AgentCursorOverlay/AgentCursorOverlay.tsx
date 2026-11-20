import {
  type FC,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AGENT_CURSOR_EVENT,
  AGENT_CURSOR_FLOWER_EVENT,
  FLOWER_CORNER,
  FLOWER_GRIP,
  clickRingColor,
  resetsFlowerSettle,
  type AgentCursorEvent,
  type AgentCursorFlowerEvent,
  type AgentCursorFlowerState,
} from '@snaglet/shared/constants/agentCursor';
import { escapeRegex } from '@snaglet/shared/utils';
import { FlowerAvatar } from '@desktop/components/agentCursor/FlowerAvatar';
import { useAgentSpecs } from '@desktop/components/agentCursor/useAgentSpecs';
import { useThemePalette } from '@desktop/components/agentCursor/useThemePalette';
import { getApiUrl } from '@desktop/utils/api';
import { useWs } from '@desktop/ws/useWs';
import {
  applyFlowerSnapshot,
  applyFlowerUpdate,
  dismissFlower,
  isAgentCursorEvent,
  isAgentCursorFlowerEvent,
  isAgentCursorFlowerState,
  isFlowerInteractive,
  nextSettleAt,
  nextSettleUntil,
  parkFlower,
  pruneStaleCursors,
  reduceCursorEvent,
  screenToViewport,
  settleAfterReconnect,
  viewportToScreen,
  type CursorMap,
  type Viewport,
} from './cursorReducer';
import { ClarificationCard } from './ClarificationCard';
import { usePendingClarifications } from './clarificationStore';
import '@desktop/components/AgentCursorApproval/AgentCursorApproval.css';
import './AgentCursorOverlay.css';

type Point = { x: number; y: number };

type Action =
  | { type: 'event'; event: AgentCursorEvent }
  | { type: 'flower'; update: AgentCursorFlowerEvent }
  | { type: 'sync'; flowers: AgentCursorFlowerState[]; standalone: boolean }
  | { type: 'dismiss'; agentId: string }
  | { type: 'park'; agentId: string; at: Point }
  | { type: 'prune'; keep?: string[] }
  | { type: 'clear' };

function reducer(map: CursorMap, action: Action): CursorMap {
  switch (action.type) {
    case 'event':
      return reduceCursorEvent(map, action.event, Date.now());
    case 'flower':
      return applyFlowerUpdate(map, action.update);
    case 'sync':
      return applyFlowerSnapshot(map, action.flowers, action.standalone);
    case 'dismiss':
      return dismissFlower(map, action.agentId);
    case 'park':
      return parkFlower(map, action.agentId, action.at);
    case 'prune': {
      const now = Date.now();
      // A flower with an unanswered question beside it must not idle-expire under the user.
      let held = map;
      for (const id of action.keep ?? []) {
        if (held[id]) held = { ...held, [id]: { ...held[id], seenAt: now } };
      }
      return pruneStaleCursors(held, now);
    }
    case 'clear':
      return {};
  }
}

/** Pull a payload of `type` out of a ws frame, whatever envelope the server used. */
function extractFrame<T>(
  message: unknown,
  type: string,
  guard: (value: unknown) => value is T
): T | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as { type?: unknown; payload?: unknown; channel?: unknown };
  const p = m.payload as { type?: unknown; payload?: unknown } | undefined;
  if (m.type === type && guard(m.payload)) return m.payload;
  if (p && p.type === type && guard(p.payload)) return p.payload;
  // Bare payload on a channel named for the event.
  if (
    m.channel === type &&
    guard(m.payload) &&
    (m.payload as { kind?: unknown }).kind === undefined
  )
    return m.payload;
  return null;
}

const AVATAR_SIZE = 80;
/** The avatar's box starts this far up-left of its anchor (the click point). */
const BOX_LEAD = -FLOWER_GRIP.left;
/** Pointer travel (px) before a press on a flower becomes a drag. */
const DRAG_START_PX = 4;
/** A drag takes the mouse only while the mouse keeps reporting; a lost one lets go. */
const DRAG_INPUT_FRESH_MS = 1000;
/** A held press renews its grab this often (the server lets an unrenewed one lapse). */
const GRAB_RENEW_MS = 3000;
/** After a reconnect, a failed read of the server's flower state is retried this often. */
const RESYNC_RETRY_MS = 2000;
/** A flower dropped with less than this share of it still in view is hidden, like its ×. */
const MIN_IN_VIEW = 0.5;
/** The reason is shown in full; only an absurdly long one is cut so it cannot become a wall of text. */
const MAX_LABEL_CHARS = 600;
const clampLabel = (label: string): string =>
  label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS)}…` : label;
/**
 * The tag already shows the name in bold, so a reason that starts with the
 * same name ("Patty: opening…", "patty — opening…") would print it twice. Drop it.
 */
const stripLeadingName = (label: string, name: string | undefined): string => {
  const n = name?.trim();
  if (!n) return label;
  const stripped = label.replace(
    new RegExp(`^\\s*${escapeRegex(n)}\\s*(?:[:\\-–—,|]\\s*)+`, 'i'),
    ''
  );
  return stripped.trim() ? stripped : label;
};
/** Closer to the top than this (px), the tag opens below the avatar, not above it. */
const TAG_BELOW_UNDER_Y = 170;
const HEARTBEAT_MS = 4000;
/** The native overlay appends this to its WebView user agent (CursorOverlay.swift). */
const NATIVE_OVERLAY_UA = 'SnagletCursorOverlay';
/** The grip, positioned from the shared numbers the server mirrors. */
const GRIP_STYLE = {
  left: FLOWER_GRIP.left,
  top: FLOWER_GRIP.top,
  width: FLOWER_GRIP.right - FLOWER_GRIP.left,
  height: FLOWER_GRIP.bottom - FLOWER_GRIP.top,
};

/**
 * The standalone page's window covers the main display from the origin, so there
 * screen coordinates are viewport coordinates.
 */
function readViewport(standalone: boolean): Viewport {
  return {
    screenX: standalone ? 0 : window.screenX,
    screenY: standalone ? 0 : window.screenY,
    outerHeight: standalone ? window.innerHeight : window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  };
}

function cornerAnchor(index: number, view: Viewport): Point {
  return {
    x: view.innerWidth - FLOWER_CORNER.margin - index * FLOWER_CORNER.spacing,
    y: view.innerHeight - FLOWER_CORNER.margin - FLOWER_CORNER.rise,
  };
}

/** Where a flower is drawn (viewport point of its anchor): parked, waiting in the corner, or at the pointer. */
function anchorOf(map: CursorMap, id: string, view: Viewport): Point {
  const entry = map[id];
  if (entry.parkedAt) return screenToViewport(entry.parkedAt.x, entry.parkedAt.y, view);
  if (entry.event.state === 'waiting') return cornerAnchor(Object.keys(map).indexOf(id), view);
  return screenToViewport(entry.event.x, entry.event.y, view);
}

/** Share of the avatar's box inside the viewport when its anchor is at `at`. */
function shareInView(at: Point, view: Viewport): number {
  const span = (start: number, max: number) =>
    Math.max(0, Math.min(start + AVATAR_SIZE, max) - Math.max(start, 0));
  return (
    (span(at.x - BOX_LEAD, view.innerWidth) * span(at.y - BOX_LEAD, view.innerHeight)) /
    (AVATAR_SIZE * AVATAR_SIZE)
  );
}

const postFlower = (path: 'dismiss' | 'park' | 'grab', body: Record<string, unknown>): void =>
  void fetch(getApiUrl(`/computer/cursor/${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((err) => console.debug('[cursor] request failed', err));

interface Gesture {
  agentId: string;
  session?: string;
  /** Viewport point where the press started. */
  start: Point;
  /** Press point minus the flower's anchor, so the flower keeps its place under the pointer. */
  grip: Point;
  dragging: boolean;
  /** The press began on the visible × (the standalone page hit-tests it itself). */
  onClose: boolean;
  /** Epoch ms of the last mouse report for this press, and of the last grab sent. */
  lastInputAt: number;
  grabbedAt: number;
}

/** A drag keeps its flower taking the mouse only while connected and the mouse keeps reporting. */
const dragIsLive = (g: Gesture | null, connected: boolean, now: number): boolean =>
  !!g && g.dragging && connected && now - g.lastInputAt < DRAG_INPUT_FRESH_MS;

/** Tell the server the person holds (or let go of) this flower. */
function sendGrab(g: Gesture, held: boolean): void {
  g.grabbedAt = Date.now();
  postFlower('grab', { agentId: g.agentId, session: g.session, held });
}

/** One pointer report from the native overlay (CursorOverlay.swift), in screen points. */
interface NativeFlowerInput {
  kind: 'hover' | 'leave' | 'down' | 'move' | 'up' | 'cancel';
  agentId: string;
  x: number;
  y: number;
}

interface FlowerWindow {
  /** Read by the native overlay: each flower's grip rect and whether it takes the mouse now. */
  __snagletCursorFlowers?: () => string;
  /** Called by the native overlay with the mouse on a flower's panel. */
  __snagletCursorFlowerInput?: (input: NativeFlowerInput) => void;
}

/**
 * `standalone` is the system-wide overlay page: its window covers the main
 * display from the origin, so screen coordinates are viewport coordinates.
 * It takes no DOM input (its page is click-through): the native overlay reads
 * where each flower's grip is and forwards the mouse on it. It has no key
 * handling or pill, and tells the server it is alive.
 *
 * A flower takes the mouse only once no flower has moved for the settle time
 * (isFlowerInteractive), and in the app window only while Snaglet has focus. Then
 * hovering shows its ×, which hides it for the rest of the agent's cursor session;
 * dragging parks it where it is dropped, and dropping it mostly out of view hides
 * it. The agent keeps working either way.
 */
export const AgentCursorOverlay: FC<{ standalone?: boolean }> = ({ standalone = false }) => {
  // The pointer handlers and the native overlay's poll read the store, not the last render,
  // so a flower ignores the mouse from the moment a new event is handled.
  const storeRef = useRef<CursorMap>({});
  const [cursors, setCursors] = useState<CursorMap>({});
  const dispatch = useCallback((action: Action) => {
    const next = reducer(storeRef.current, action);
    if (next === storeRef.current) return;
    storeRef.current = next;
    setCursors(next);
  }, []);
  // No flower takes the mouse before this: any agent's action holds them all.
  const settleUntilRef = useRef(0);
  const [settleUntil, setSettleUntil] = useState(0);
  const holdFlowers = useCallback((until: number) => {
    if (until === settleUntilRef.current) return;
    settleUntilRef.current = until;
    setSettleUntil(until);
  }, []);
  const { addMessageListener, connectionState } = useWs();
  const { specFor } = useAgentSpecs();
  const palette = useThemePalette();
  const [tick, bump] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverIdRef = useRef(hoverId);
  hoverIdRef.current = hoverId;
  const [drag, setDrag] = useState<{ agentId: string; at: Point } | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  // While the overlay re-reads the flowers after a lost connection, none takes the mouse.
  const syncingRef = useRef(false);
  const [syncing, setSyncing] = useState(false);
  const holdForSync = useCallback((on: boolean) => {
    syncingRef.current = on;
    setSyncing(on);
  }, []);
  // Without a live socket an overlay cannot hear the next event, so no flower takes the mouse.
  const connectedRef = useRef(connectionState === 'open');
  connectedRef.current = connectionState === 'open';
  const ids = Object.keys(cursors);
  const active = ids.length > 0;

  // An Ask from an agent that has a flower on screen is also offered on a card next to it
  // (the composer panel stays up too; answering on either closes both). The standalone system overlay is
  // strictly display-only and never shows the card; its window has no access to the
  // thread's frames anyway, so the composer panel is the fallback there.
  const pendingAsks = usePendingClarifications();
  const asks = standalone
    ? []
    : pendingAsks.filter((p) => p.request.agentId && cursors[p.request.agentId] && active);
  const askAgentsRef = useRef<string[]>([]);
  askAgentsRef.current = asks.map((a) => a.request.agentId as string);

  // In the app window a click on an unfocused Snaglet would bring Snaglet forward, and the agent's
  // next keystrokes with it, so flowers there take the mouse only while Snaglet has focus.
  const interactiveNow = useCallback(
    (agentId: string): boolean => {
      const entry = storeRef.current[agentId];
      return (
        !!entry &&
        connectedRef.current &&
        (standalone || document.hasFocus()) &&
        !syncingRef.current &&
        isFlowerInteractive(entry, Date.now(), settleUntilRef.current)
      );
    },
    [standalone]
  );

  const dismiss = useCallback(
    (agentId: string, pointer?: Point) => {
      const session = storeRef.current[agentId]?.session;
      dispatch({ type: 'dismiss', agentId });
      setHoverId((h) => (h === agentId ? null : h));
      postFlower('dismiss', { agentId, session, ...(pointer ? { pointer } : {}) });
    },
    [dispatch]
  );

  const press = useCallback(
    (agentId: string, at: Point, onClose: boolean) => {
      if (!interactiveNow(agentId)) return;
      const anchor = anchorOf(storeRef.current, agentId, readViewport(standalone));
      const now = Date.now();
      const g: Gesture = {
        agentId,
        session: storeRef.current[agentId].session,
        start: at,
        grip: { x: at.x - anchor.x, y: at.y - anchor.y },
        dragging: false,
        onClose,
        lastInputAt: now,
        grabbedAt: now,
      };
      gestureRef.current = g;
      // The server holds the agent's input from the press on, so a slow reach is not a takeover.
      sendGrab(g, true);
    },
    [interactiveNow, standalone]
  );

  const cancelGesture = useCallback(() => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    if (g.dragging) setDrag(null);
    sendGrab(g, false);
  }, []);

  const movePointer = useCallback(
    (at: Point) => {
      const g = gestureRef.current;
      if (!g) return;
      const now = Date.now();
      g.lastInputAt = now;
      if (now - g.grabbedAt >= GRAB_RENEW_MS) sendGrab(g, true);
      if (!g.dragging) {
        if (Math.hypot(at.x - g.start.x, at.y - g.start.y) < DRAG_START_PX) return;
        if (!interactiveNow(g.agentId)) {
          cancelGesture();
          return;
        }
        g.dragging = true;
      }
      setDrag({ agentId: g.agentId, at: { x: at.x - g.grip.x, y: at.y - g.grip.y } });
    },
    [cancelGesture, interactiveNow]
  );

  const release = useCallback(
    (at: Point) => {
      const g = gestureRef.current;
      gestureRef.current = null;
      if (!g) return;
      const view = readViewport(standalone);
      const pointer = viewportToScreen(at.x, at.y, view);
      if (!g.dragging) {
        if (g.onClose && interactiveNow(g.agentId)) dismiss(g.agentId, pointer);
        else sendGrab(g, false);
        return;
      }
      setDrag(null);
      const anchor = { x: at.x - g.grip.x, y: at.y - g.grip.y };
      if (shareInView(anchor, view) < MIN_IN_VIEW) {
        dismiss(g.agentId, pointer);
        return;
      }
      const screenAt = viewportToScreen(anchor.x, anchor.y, view);
      dispatch({ type: 'park', agentId: g.agentId, at: screenAt });
      postFlower('park', {
        agentId: g.agentId,
        session: g.session,
        x: screenAt.x,
        y: screenAt.y,
        pointer,
      });
    },
    [dismiss, dispatch, interactiveNow, standalone]
  );

  useEffect(
    () =>
      addMessageListener((message) => {
        const update = extractFrame(message, AGENT_CURSOR_FLOWER_EVENT, isAgentCursorFlowerEvent);
        if (update) {
          dispatch({ type: 'flower', update });
          return;
        }
        const event = extractFrame(message, AGENT_CURSOR_EVENT, isAgentCursorEvent);
        if (!event) return;
        holdFlowers(nextSettleUntil(settleUntilRef.current, event, Date.now()));
        // The system-wide overlay draws this one; do not draw it twice.
        const shown = standalone || !event.systemOverlay;
        dispatch({ type: 'event', event: shown ? event : { ...event, state: 'hidden' } });
        // A press that has not become a drag yet ends with any agent's action; a drag in
        // progress keeps going (the server holds the agents' input until the drop).
        const g = gestureRef.current;
        if (!g) return;
        if (!storeRef.current[g.agentId]) cancelGesture();
        else if (!g.dragging && resetsFlowerSettle(event)) cancelGesture();
      }),
    [addMessageListener, cancelGesture, dispatch, holdFlowers, standalone]
  );

  // After a lost connection the overlay may have missed events: hold every flower until it
  // has the server's view of which flowers are still up, hidden or parked (retrying until it
  // gets it), then for a settle time.
  const wasOpenRef = useRef(connectionState === 'open');
  const lostRef = useRef(false);
  useEffect(() => {
    if (connectionState !== 'open') {
      if (wasOpenRef.current) lostRef.current = true;
      return;
    }
    wasOpenRef.current = true;
    if (!lostRef.current) return;
    lostRef.current = false;
    holdFlowers(settleAfterReconnect(settleUntilRef.current, Date.now()));
    if (Object.keys(storeRef.current).length === 0) {
      holdForSync(false);
      return;
    }
    holdForSync(true);
    let current = true;
    let retry: number | undefined;
    const attempt = (): void => {
      fetch(getApiUrl('/computer/cursor/flowers'))
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((body: { flowers?: unknown } | null) => {
          if (!current) return;
          if (!Array.isArray(body?.flowers)) throw new Error('no flower list');
          dispatch({
            type: 'sync',
            flowers: body.flowers.filter(isAgentCursorFlowerState),
            standalone,
          });
          holdFlowers(settleAfterReconnect(settleUntilRef.current, Date.now()));
          holdForSync(false);
        })
        .catch((err) => {
          console.debug('[cursor] flower resync failed', err);
          if (current) retry = window.setTimeout(attempt, RESYNC_RETRY_MS);
        });
    };
    attempt();
    return () => {
      // A read cut off here starts over at the next reconnect; until then the lost
      // connection keeps every flower from taking the mouse.
      current = false;
      window.clearTimeout(retry);
      holdForSync(false);
    };
  }, [connectionState, dispatch, holdFlowers, holdForSync, standalone]);

  // Standalone: tell the server the system overlay is alive (so the in-app one stands down)
  // and how big the display is (so it knows where flowers can be). Only the native overlay
  // window does this; a browser tab on ?cursorOverlay=1 must not.
  useEffect(() => {
    if (!standalone || !navigator.userAgent.includes(NATIVE_OVERLAY_UA)) return;
    const beat = () =>
      void fetch(getApiUrl('/computer/overlay-heartbeat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width: window.innerWidth, height: window.innerHeight }),
      }).catch((err) => console.debug('[cursor] request failed', err));
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    // The window follows the display, so a resize means a new display size.
    window.addEventListener('resize', beat);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', beat);
    };
  }, [standalone]);

  // Standalone: the native overlay polls each flower's grip and forwards the mouse on it.
  useEffect(() => {
    if (!standalone) return;
    const w = window as unknown as FlowerWindow;
    w.__snagletCursorFlowers = () => {
      const now = Date.now();
      const flowers: Array<{
        id: string;
        x: number;
        y: number;
        w: number;
        h: number;
        live: boolean;
      }> = [];
      for (const el of document.querySelectorAll<HTMLElement>('[data-flower-grip]')) {
        const id = el.dataset.flowerGrip ?? '';
        if (!storeRef.current[id]) continue;
        const g = gestureRef.current;
        const live =
          g?.agentId === id && g.dragging
            ? dragIsLive(g, connectedRef.current && !syncingRef.current, now)
            : interactiveNow(id);
        const r = el.getBoundingClientRect();
        flowers.push({ id, x: r.left, y: r.top, w: r.width, h: r.height, live });
      }
      return JSON.stringify({ flowers });
    };
    w.__snagletCursorFlowerInput = (input) => {
      const at = { x: Number(input?.x), y: Number(input?.y) };
      if (!input || typeof input.agentId !== 'string') return;
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
      if (input.kind === 'hover') {
        setHoverId(interactiveNow(input.agentId) ? input.agentId : null);
      } else if (input.kind === 'leave') {
        setHoverId((h) => (h === input.agentId ? null : h));
      } else if (input.kind === 'down') {
        const close = document
          .querySelector(`[data-flower-close="${CSS.escape(input.agentId)}"]`)
          ?.getBoundingClientRect();
        const onClose =
          !!close &&
          hoverIdRef.current === input.agentId &&
          at.x >= close.left &&
          at.x <= close.right &&
          at.y >= close.top &&
          at.y <= close.bottom;
        press(input.agentId, at, onClose);
      } else if (input.kind === 'move') {
        movePointer(at);
      } else if (input.kind === 'up') {
        release(at);
      } else if (input.kind === 'cancel') {
        cancelGesture();
      }
    };
    return () => {
      delete w.__snagletCursorFlowers;
      delete w.__snagletCursorFlowerInput;
    };
  }, [cancelGesture, interactiveNow, movePointer, press, release, standalone]);

  // In-app drags follow the window's mouse until the button comes up or the window loses focus.
  const endWindowDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endWindowDrag.current?.(), []);
  const onGripMouseDown = (agentId: string) => (e: ReactMouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-flower-close]')) return;
    e.preventDefault();
    press(agentId, { x: e.clientX, y: e.clientY }, false);
    if (!gestureRef.current) return;
    endWindowDrag.current?.();
    const listeners = {
      move: (ev: MouseEvent) => movePointer({ x: ev.clientX, y: ev.clientY }),
      up: (ev: MouseEvent) => {
        detach();
        release({ x: ev.clientX, y: ev.clientY });
      },
      blur: () => {
        detach();
        cancelGesture();
      },
    };
    function detach() {
      window.removeEventListener('mousemove', listeners.move);
      window.removeEventListener('mouseup', listeners.up);
      window.removeEventListener('blur', listeners.blur);
      endWindowDrag.current = null;
    }
    window.addEventListener('mousemove', listeners.move);
    window.addEventListener('mouseup', listeners.up);
    window.addEventListener('blur', listeners.blur);
    endWindowDrag.current = detach;
  };

  // Dev-only manual trigger, flows through the same reducer.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __snagletCursorDemo?: (name?: string) => void };
    w.__snagletCursorDemo = (name = 'Demo') => {
      const base = {
        agentId: `demo-${name}`,
        name,
        flower: 'tulip' as const,
        color: '#ef5d8a',
        holderAgentId: null,
      };
      const sx = window.screenX;
      const sy = window.screenY + (window.outerHeight - window.innerHeight);
      const at = (dx: number, dy: number) => ({ x: sx + dx, y: sy + dy });
      const steps: Array<Partial<AgentCursorEvent> & { t: number }> = [
        { t: 0, state: 'move', ...at(200, 200), label: 'Looking around' },
        { t: 900, state: 'move', ...at(500, 320), label: 'Heading to the button' },
        { t: 1800, state: 'click', ...at(500, 320), label: 'Clicking' },
        { t: 3000, state: 'move', ...at(300, 450), label: 'Done' },
        { t: 4500, state: 'waiting', ...at(0, 0), label: 'Waiting for you' },
        { t: 8000, state: 'hidden', ...at(0, 0) },
      ];
      for (const s of steps) {
        const { t, ...rest } = s;
        window.setTimeout(
          () => dispatch({ type: 'event', event: { ...base, state: 'move', x: 0, y: 0, ...rest } }),
          t
        );
      }
    };
    return () => {
      delete (window as unknown as { __snagletCursorDemo?: unknown }).__snagletCursorDemo;
    };
  }, [dispatch]);

  // Idle expiry + window-move/resize/focus re-render.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(
      () => dispatch({ type: 'prune', keep: askAgentsRef.current }),
      1000
    );
    const rerender = () => bump((n) => n + 1);
    window.addEventListener('resize', rerender);
    window.addEventListener('focus', rerender);
    window.addEventListener('blur', rerender);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', rerender);
      window.removeEventListener('focus', rerender);
      window.removeEventListener('blur', rerender);
    };
  }, [active, dispatch]);

  // Re-render when the next flower settles, so it starts taking the mouse on time.
  useEffect(() => {
    if (syncing) return;
    const at = nextSettleAt(cursors, Date.now(), settleUntil);
    if (at === null) return;
    const timer = window.setTimeout(() => bump((n) => n + 1), Math.max(0, at - Date.now()));
    return () => window.clearTimeout(timer);
  }, [cursors, settleUntil, syncing, tick]);

  const stop = useCallback(() => {
    cancelGesture();
    dispatch({ type: 'clear' });
    void fetch(getApiUrl('/computer/stop'), { method: 'POST' }).catch((err) =>
      console.debug('[cursor] request failed', err)
    );
  }, [cancelGesture, dispatch]);
  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    if (!active || standalone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, standalone]);

  if (!active) return null;

  const view = readViewport(standalone);
  const now = Date.now();
  const connected = connectionState === 'open';
  const mayTakeMouse = connected && !syncing && (standalone || document.hasFocus());

  // A hidden flower's question falls back to the corner; the composer panel has it too.
  const askAnchorFor = (id: string): Point =>
    cursors[id].dismissed ? cornerAnchor(0, view) : anchorOf(cursors, id, view);

  return (
    <>
      <div className="snaglet-agent-cursors" data-testid="agent-cursor-overlay">
        {ids.map((id) => {
          const entry = cursors[id];
          if (entry.dismissed) return null;
          const { event } = entry;
          const waiting = event.state === 'waiting';
          const spec = specFor(event.agentId);
          const petal = palette[spec.colors.petal];
          const dragging = drag?.agentId === id;
          const pos = dragging ? drag.at : anchorOf(cursors, id, view);
          const live = dragging
            ? dragIsLive(gestureRef.current, connected && !syncing, now)
            : mayTakeMouse && isFlowerInteractive(entry, now, settleUntil);
          const glide = event.glideMs !== undefined && !waiting && !entry.parkedAt;
          return (
            <div
              key={id}
              className={`snaglet-agent-cursor${waiting ? ' is-waiting' : ''}${dragging ? ' is-dragging' : ''}`}
              style={{
                transform: `translate(${pos.x}px, ${pos.y}px)`,
                ...(glide && !dragging
                  ? { transition: `transform ${event.glideMs}ms linear` }
                  : {}),
              }}
            >
              <div className="snaglet-agent-cursor__body" aria-hidden>
                {event.state === 'click' ? (
                  <div
                    key={`ring-${entry.seenAt}`}
                    className="snaglet-agent-cursor__ring"
                    data-testid="agent-cursor-ring"
                    style={{ color: petal || clickRingColor(event.flower, event.color) }}
                  />
                ) : null}
                <div
                  key={
                    event.animationId ??
                    (event.state === 'click' ? `click-${entry.seenAt}` : 'steady')
                  }
                  className={`snaglet-agent-cursor__flower${event.state === 'click' ? ' is-click' : ''}${event.animation ? ` emote-${event.animation}` : ''}`}
                  data-emote={event.animation}
                >
                  <FlowerAvatar
                    spec={spec}
                    emotion={entry.emotion ?? 'neutral'}
                    crying={event.animation === 'cry'}
                    celebrating={event.animation === 'celebrate'}
                    size={AVATAR_SIZE}
                  />
                </div>
                <div
                  className={`snaglet-agent-cursor__tag${pos.y < TAG_BELOW_UNDER_Y ? ' is-below' : ''}`}
                >
                  <strong>{event.name}</strong>
                  {event.label ? (
                    <span> {clampLabel(stripLeadingName(event.label, event.name))}</span>
                  ) : null}
                </div>
              </div>
              <div
                className={`snaglet-agent-cursor__grip${live ? ' is-live' : ''}${hoverId === id ? ' is-hover' : ''}`}
                style={GRIP_STYLE}
                data-flower-grip={id}
                data-testid="agent-cursor-grip"
                onMouseDown={onGripMouseDown(id)}
                onMouseEnter={() => setHoverId(id)}
                onMouseLeave={() => setHoverId((h) => (h === id ? null : h))}
              >
                <button
                  type="button"
                  className="snaglet-agent-cursor__close"
                  data-flower-close={id}
                  aria-label={`Hide ${event.name}'s cursor`}
                  title={`Hide ${event.name}'s cursor`}
                  onClick={(e) => {
                    // A mouse click counts only while the flower takes the mouse; the keyboard
                    // always may (and leaves the pointer, and so the takeover check, alone).
                    const byMouse = e.detail > 0;
                    if (byMouse && !interactiveNow(id)) return;
                    dismiss(
                      id,
                      byMouse
                        ? viewportToScreen(e.clientX, e.clientY, readViewport(standalone))
                        : undefined
                    );
                  }}
                >
                  <span aria-hidden>×</span>
                </button>
              </div>
            </div>
          );
        })}
        {standalone ? null : (
          <div className="snaglet-agent-cursors__pill" role="status">
            Agent cursor active — Esc to stop
          </div>
        )}
      </div>
      {asks.length > 0 ? (
        <div className="snaglet-agent-asks">
          {asks.map(({ request, respond }) => (
            <ClarificationCard
              key={request.callId}
              request={request}
              respond={respond}
              anchor={askAnchorFor(request.agentId as string)}
              agentName={cursors[request.agentId as string].event.name}
            />
          ))}
        </div>
      ) : null}
    </>
  );
};
