import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CURSOR_SESSION_IDLE_MS,
  FLOWER_CORNER,
  FLOWER_GRIP,
  FLOWER_HANDOFF_MS,
  FLOWER_SETTLE_MS,
} from '@snaglet/shared/constants/agentCursor';
import {
  AgentCursorSessions,
  FLOWER_GRAB_MAX_MS,
  FLOWER_ZONE_MARGIN,
  OVERLAY_LAG_MS,
} from '@server/services/agentCursorSessions';

const agent = 'test-agent-a';
const other = 'test-agent-b';
type Emit = {
  agentId?: string;
  state?: 'move' | 'idle' | 'click' | 'hidden' | 'waiting';
  emotionUpdate?: 'renew';
  glideMs?: number;
  x?: number;
  y?: number;
  systemOverlay?: boolean;
};

function setup(screen: { width: number; height: number } | null = null) {
  let now = 1_000_000;
  let n = 0;
  const sessions = new AgentCursorSessions(
    () => now,
    () => `cursor-${++n}`,
    () => screen
  );
  return {
    sessions,
    advance: (ms: number) => {
      now += ms;
    },
    emit: (e: Emit = {}) =>
      sessions.onEmit({ agentId: agent, state: 'move', x: 500, y: 300, ...e }),
  };
}

describe('overlay timing', () => {
  it('the lag window covers the native poll, and the handoff covers the lag', () => {
    const swift = readFileSync(
      join(process.cwd(), 'apps/server/native/cursor-overlay/CursorOverlay.swift'),
      'utf8'
    );
    const poll = Number(/let flowerPollSeconds: TimeInterval = ([\d.]+)/.exec(swift)?.[1]);
    expect(poll).toBeGreaterThan(0);
    expect(OVERLAY_LAG_MS).toBeGreaterThanOrEqual(poll * 1000 * 2);
    expect(OVERLAY_LAG_MS).toBeLessThan(FLOWER_HANDOFF_MS);
  });
});

describe('agentCursorSessions', () => {
  it('stamps every event of a session with the same id, and a hidden event ends it', () => {
    const { emit } = setup();
    expect(emit()).toEqual({ session: 'cursor-1' });
    expect(emit({ state: 'idle' })).toEqual({ session: 'cursor-1' });
    expect(emit({ state: 'hidden' })).toEqual({});
    expect(emit()).toEqual({ session: 'cursor-2' });
  });

  it('starts a new session after the idle expiry', () => {
    const { emit, advance } = setup();
    emit();
    advance(CURSOR_SESSION_IDLE_MS - 1);
    expect(emit()).toEqual({ session: 'cursor-1' });
    advance(CURSOR_SESSION_IDLE_MS);
    expect(emit()).toEqual({ session: 'cursor-2' });
  });

  it('a hidden flower stays hidden for the session, then the next session shows it again', () => {
    const { sessions, emit } = setup();
    emit();
    expect(sessions.dismiss(agent, 'cursor-1')).toEqual({
      agentId: agent,
      session: 'cursor-1',
      dismissed: true,
      parkedAt: null,
    });
    expect(emit()).toEqual({ session: 'cursor-1', dismissed: true });
    emit({ state: 'hidden' });
    expect(emit()).toEqual({ session: 'cursor-2' });
  });

  it('a parked flower carries its spot on later events; parking again moves it', () => {
    const { sessions, emit } = setup();
    emit();
    sessions.park(agent, 'cursor-1', { x: 40, y: 50 });
    expect(emit()).toEqual({ session: 'cursor-1', parkedAt: { x: 40, y: 50 } });
    expect(sessions.park(agent, 'cursor-1', { x: 7, y: 8 })?.parkedAt).toEqual({ x: 7, y: 8 });
  });

  it('refuses an action for an agent with no flower up, or for another session', () => {
    const { sessions, emit, advance } = setup();
    expect(sessions.dismiss(agent, 'cursor-1')).toBeNull();
    expect(sessions.park(agent, 'cursor-1', { x: 1, y: 1 })).toBeNull();
    expect(sessions.grab(agent, 'cursor-1', true)).toBe(false);
    emit();
    // A late action from the session before never lands on the next one.
    expect(sessions.dismiss(agent, 'cursor-0')).toBeNull();
    expect(sessions.grab(agent, 'cursor-0', true)).toBe(false);
    advance(CURSOR_SESSION_IDLE_MS);
    expect(sessions.dismiss(agent, 'cursor-1')).toBeNull();
  });

  it('a grab on any flower holds until let go, parked, hidden or its expiry', () => {
    const { sessions, emit, advance } = setup();
    emit();
    emit({ agentId: other });
    expect(sessions.grab(other, 'cursor-2', true)).toBe(true);
    expect(sessions.anyGrabbed()).toBe(true);
    sessions.grab(other, 'cursor-2', false);
    expect(sessions.anyGrabbed()).toBe(false);
    sessions.grab(agent, 'cursor-1', true);
    sessions.park(agent, 'cursor-1', { x: 1, y: 2 });
    expect(sessions.anyGrabbed()).toBe(false);
    sessions.grab(agent, 'cursor-1', true);
    sessions.dismiss(agent, 'cursor-1');
    expect(sessions.anyGrabbed()).toBe(false);
    sessions.grab(other, 'cursor-2', true);
    advance(FLOWER_GRAB_MAX_MS);
    expect(sessions.anyGrabbed()).toBe(false);
  });

  it('lists the live sessions and their choices for a resync', () => {
    const { sessions, emit, advance } = setup();
    emit({ systemOverlay: true });
    sessions.park(agent, 'cursor-1', { x: 3, y: 4 });
    advance(CURSOR_SESSION_IDLE_MS - 10);
    emit({ agentId: other });
    expect(sessions.snapshot()).toEqual([
      {
        agentId: agent,
        session: 'cursor-1',
        dismissed: false,
        parkedAt: { x: 3, y: 4 },
        systemOverlay: true,
      },
      {
        agentId: other,
        session: 'cursor-2',
        dismissed: false,
        parkedAt: null,
        systemOverlay: false,
      },
    ]);
    advance(20);
    expect(sessions.snapshot().map((f) => f.agentId)).toEqual([other]);
  });

  describe('needsHandoff', () => {
    it('is false while the flower is still settling, and true from the handoff lead on', () => {
      const { sessions, emit, advance } = setup();
      expect(sessions.needsHandoff(null)).toBe(false);
      emit();
      expect(sessions.needsHandoff(null)).toBe(false);
      advance(FLOWER_SETTLE_MS - FLOWER_HANDOFF_MS - 1);
      expect(sessions.needsHandoff(null)).toBe(false);
      advance(1);
      expect(sessions.needsHandoff(null)).toBe(true);
    });

    it("counts another agent's settled flower, and any agent's action holds them all", () => {
      const { sessions, emit, advance } = setup();
      emit({ agentId: other });
      advance(FLOWER_SETTLE_MS);
      expect(sessions.needsHandoff(null)).toBe(true);
      // This agent acts: every flower is held click-through for a settle time (once any
      // overlay lag behind the live one has passed).
      emit();
      expect(sessions.needsHandoff(null)).toBe(true);
      advance(OVERLAY_LAG_MS + 1);
      expect(sessions.needsHandoff(null)).toBe(false);
      // This agent's flower goes away; the other agent's settled one is still there.
      emit({ state: 'hidden' });
      advance(FLOWER_SETTLE_MS);
      expect(sessions.needsHandoff(null)).toBe(true);
    });

    it('right after an action, still waits while a flower that was taking the mouse may lag', () => {
      // The native panel follows the page on a 100 ms poll: a flower that was live just
      // before an event can still catch input for a moment, wherever it was.
      const { sessions, emit, advance } = setup({ width: 1440, height: 900 });
      emit({ x: 500, y: 300, systemOverlay: true });
      advance(FLOWER_SETTLE_MS);
      emit({ agentId: other, x: 1000, y: 700, systemOverlay: true });
      advance(5);
      expect(sessions.needsHandoff([{ x: 1200, y: 800 }])).toBe(true);
      advance(OVERLAY_LAG_MS);
      expect(sessions.needsHandoff([{ x: 1200, y: 800 }])).toBe(false);
      // Nothing was live before this action, so there is nothing to lag behind.
      emit({ x: 600, y: 300, systemOverlay: true });
      expect(sessions.needsHandoff([{ x: 1200, y: 800 }])).toBe(false);
    });

    it('counts a glide on top of the settle time', () => {
      const { sessions, emit, advance } = setup();
      emit({ glideMs: 3000 });
      advance(FLOWER_SETTLE_MS);
      expect(sessions.needsHandoff(null)).toBe(false);
      advance(3000);
      expect(sessions.needsHandoff(null)).toBe(true);
    });

    it('emotion refreshes do not hold the flowers; actions do', () => {
      const { sessions, emit, advance } = setup();
      emit();
      advance(FLOWER_SETTLE_MS);
      emit({ state: 'idle', emotionUpdate: 'renew' });
      emit({ agentId: other, state: 'idle', emotionUpdate: 'renew' });
      expect(sessions.needsHandoff(null)).toBe(true);
      emit({ state: 'click' });
      advance(OVERLAY_LAG_MS + 1);
      expect(sessions.needsHandoff(null)).toBe(false);
    });

    it('stays on for an expired session an overlay may not have pruned yet, then forgets it', () => {
      const { sessions, emit, advance } = setup();
      emit();
      advance(CURSOR_SESSION_IDLE_MS + 1000);
      expect(sessions.needsHandoff(null)).toBe(true);
      advance(10_000);
      expect(sessions.needsHandoff(null)).toBe(false);
    });

    it('turns off once a flower has been hidden for a settle time, not before', () => {
      const { sessions, emit, advance } = setup();
      emit();
      advance(FLOWER_SETTLE_MS);
      sessions.dismiss(agent, 'cursor-1');
      expect(sessions.needsHandoff(null)).toBe(true);
      advance(FLOWER_SETTLE_MS);
      expect(sessions.needsHandoff(null)).toBe(false);
    });

    describe('where the flowers are', () => {
      const screen = { width: 1440, height: 900 };
      const grip = (x: number, y: number) => ({
        inside: { x: x + FLOWER_GRIP.left + 1, y: y + FLOWER_GRIP.bottom - 1 },
        padded: { x: x + FLOWER_GRIP.right + FLOWER_ZONE_MARGIN, y: y - 30 },
        outside: { x: x + FLOWER_GRIP.right + FLOWER_ZONE_MARGIN + 1, y: y - 30 },
      });

      it('waits only when the input lands on or near a flower the system overlay draws', () => {
        const { sessions, emit, advance } = setup(screen);
        emit({ x: 500, y: 300, systemOverlay: true });
        advance(FLOWER_SETTLE_MS);
        const g = grip(500, 300);
        expect(sessions.needsHandoff([g.inside])).toBe(true);
        expect(sessions.needsHandoff([g.padded])).toBe(true);
        expect(sessions.needsHandoff([g.outside])).toBe(false);
        expect(sessions.needsHandoff([{ x: 1000, y: 700 }])).toBe(false);
        // A drag waits if either end could be on a flower; an unknown spot always waits.
        expect(sessions.needsHandoff([{ x: 1000, y: 700 }, g.inside])).toBe(true);
        expect(sessions.needsHandoff(null)).toBe(true);
      });

      it('mirrors the page: parked spots, the clamp at the display edge, the waiting corner', () => {
        const { sessions, emit, advance } = setup(screen);
        emit({ x: 500, y: 300, systemOverlay: true });
        sessions.park(agent, 'cursor-1', { x: 200, y: 200 });
        emit({ agentId: other, x: 5000, y: 5000, systemOverlay: true });
        advance(FLOWER_SETTLE_MS);
        expect(sessions.needsHandoff([grip(500, 300).inside])).toBe(false);
        expect(sessions.needsHandoff([grip(200, 200).inside])).toBe(true);
        // Drawn clamped to the display's bottom-right corner.
        expect(sessions.needsHandoff([grip(1436, 896).inside])).toBe(true);
        emit({ agentId: other, state: 'waiting', x: 10, y: 10, systemOverlay: true });
        advance(FLOWER_SETTLE_MS);
        const cornerY = screen.height - FLOWER_CORNER.margin - FLOWER_CORNER.rise;
        const leftmost = screen.width - FLOWER_CORNER.margin - FLOWER_CORNER.spacing;
        expect(sessions.needsHandoff([grip(leftmost, cornerY).inside])).toBe(true);
        expect(sessions.needsHandoff([grip(10, 10).inside])).toBe(true);
      });

      it('always waits for a flower the in-app overlay may draw, or without a display size', () => {
        const inApp = setup(screen);
        inApp.emit({ x: 500, y: 300, systemOverlay: false });
        inApp.advance(FLOWER_SETTLE_MS);
        expect(inApp.sessions.needsHandoff([{ x: 1000, y: 700 }])).toBe(true);
        const noSize = setup(null);
        noSize.emit({ x: 500, y: 300, systemOverlay: true });
        noSize.advance(FLOWER_SETTLE_MS);
        expect(noSize.sessions.needsHandoff([{ x: 1000, y: 700 }])).toBe(true);
      });
    });
  });

  describe('reachedFlower', () => {
    it('is true for a pointer on the flower, where it is or where it is being parked', () => {
      const { sessions, emit } = setup();
      emit({ x: 500, y: 300 });
      expect(sessions.reachedFlower(agent, 'cursor-1', { x: 470, y: 270 })).toBe(true);
      expect(sessions.reachedFlower(agent, 'cursor-1', { x: 900, y: 800 })).toBe(false);
      expect(
        sessions.reachedFlower(agent, 'cursor-1', { x: 870, y: 770 }, { x: 900, y: 800 })
      ).toBe(true);
      expect(sessions.reachedFlower(agent, 'cursor-0', { x: 470, y: 270 })).toBe(false);
    });

    it('is true anywhere once the person pressed the flower and dragged it', () => {
      const { sessions, emit } = setup();
      emit({ x: 500, y: 300 });
      sessions.grab(agent, 'cursor-1', true);
      expect(sessions.reachedFlower(agent, 'cursor-1', { x: 2, y: 400 })).toBe(true);
    });
  });

  describe('pointerOnFlower', () => {
    it('is true on or near any shown flower, never on a hidden one', () => {
      const { sessions, emit } = setup();
      emit({ x: 500, y: 300 });
      emit({ agentId: other, x: 900, y: 600 });
      expect(sessions.pointerOnFlower({ x: 470, y: 260 })).toBe(true);
      expect(sessions.pointerOnFlower({ x: 870, y: 560 })).toBe(true);
      expect(sessions.pointerOnFlower({ x: 700, y: 450 })).toBe(false);
      sessions.dismiss(agent, 'cursor-1');
      expect(sessions.pointerOnFlower({ x: 470, y: 260 })).toBe(false);
    });
  });
});
