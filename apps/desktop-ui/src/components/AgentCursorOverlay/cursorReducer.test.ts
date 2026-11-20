import { describe, expect, it } from 'vitest';
import {
  CURSOR_SESSION_IDLE_MS,
  FLOWER_SETTLE_MS,
  type AgentCursorEvent,
} from '@snaglet/shared/constants/agentCursor';
import {
  CURSOR_EMOTION_MS,
  applyFlowerSnapshot,
  applyFlowerUpdate,
  dismissFlower,
  isFlowerInteractive,
  nextSettleAt,
  nextSettleUntil,
  parkFlower,
  settleAfterReconnect,
  pruneStaleCursors,
  reduceCursorEvent,
  screenToViewport,
  viewportToScreen,
} from './cursorReducer';

const ev = (over: Partial<AgentCursorEvent> = {}): AgentCursorEvent => ({
  agentId: 'a1',
  name: 'Ada',
  flower: 'daisy',
  color: '#fff',
  state: 'move',
  x: 10,
  y: 20,
  holderAgentId: 'a1',
  ...over,
});

describe('reduceCursorEvent', () => {
  it('stores the latest event per agent', () => {
    let m = reduceCursorEvent({}, ev(), 1);
    m = reduceCursorEvent(m, ev({ x: 50 }), 2);
    expect(m.a1.event.x).toBe(50);
    expect(m.a1.seenAt).toBe(2);
  });
  it('removes on hidden', () => {
    const m = reduceCursorEvent(reduceCursorEvent({}, ev(), 1), ev({ state: 'hidden' }), 2);
    expect(m).toEqual({});
  });
  it('keeps agent on idle (cursor-release path emits idle, not hidden)', () => {
    // releaseClaim() emits state:'idle' so the avatar stays on screen
    // until CURSOR_IDLE_TIMEOUT_MS prunes it — not deleted immediately.
    let m = reduceCursorEvent({}, ev({ state: 'move', x: 100, y: 200 }), 1);
    m = reduceCursorEvent(m, ev({ state: 'idle', x: 100, y: 200 }), 2);
    expect(m.a1).toBeDefined();
    expect(m.a1.event.state).toBe('idle');
    expect(m.a1.event.x).toBe(100);
    expect(m.a1.event.y).toBe(200);
  });
});

describe('pruneStaleCursors', () => {
  it('drops entries older than the timeout and keeps identity when unchanged', () => {
    const m = reduceCursorEvent({}, ev(), 0);
    expect(pruneStaleCursors(m, 100, 1000)).toBe(m);
    expect(pruneStaleCursors(m, 1000, 1000)).toEqual({});
  });
});

describe('screenToViewport', () => {
  it('offsets by window position and chrome, and clamps', () => {
    const v = { screenX: 100, screenY: 50, outerHeight: 800, innerHeight: 760, innerWidth: 1000 };
    expect(screenToViewport(200, 150, v)).toEqual({ x: 100, y: 60 });
    expect(screenToViewport(0, 0, v)).toEqual({ x: 0, y: 0 });
    expect(screenToViewport(9999, 9999, v)).toEqual({ x: 996, y: 756 });
  });
});

describe('cursor emotion', () => {
  it('stores the emotion and its time, keeps it through idle, drops it on move/click', () => {
    let m = reduceCursorEvent({}, ev({ state: 'idle', emotion: 'stumped' }), 100);
    expect(m.a1).toMatchObject({ emotion: 'stumped', emotionAt: 100 });
    m = reduceCursorEvent(m, ev({ state: 'idle' }), 200);
    expect(m.a1).toMatchObject({ emotion: 'stumped', emotionAt: 100 });
    expect(reduceCursorEvent(m, ev({ state: 'click' }), 300).a1.emotion).toBeUndefined();
    expect(reduceCursorEvent(m, ev({ state: 'move' }), 300).a1.emotion).toBeUndefined();
  });
  it('prune strips an expired emotion without removing the agent', () => {
    const m = reduceCursorEvent({}, ev({ state: 'idle', emotion: 'stumped' }), 0);
    expect(pruneStaleCursors(m, CURSOR_EMOTION_MS - 1)).toBe(m);
    const p = pruneStaleCursors(m, CURSOR_EMOTION_MS);
    expect(p.a1).toBeDefined();
    expect(p.a1.emotion).toBeUndefined();
  });
});

describe('cursor emotion renewals', () => {
  it('neutral clears the held emotion at once', () => {
    let m = reduceCursorEvent({}, ev({ state: 'idle', emotion: 'thinking' }), 100);
    m = reduceCursorEvent(m, ev({ state: 'idle', emotion: 'neutral' }), 200);
    expect(m.a1.emotion).toBeUndefined();
    expect(m.a1.emotionAt).toBeUndefined();
    expect(m.a1.seenAt).toBe(200);
  });
  it('a non-neutral emotion event refreshes emotionAt', () => {
    let m = reduceCursorEvent({}, ev({ state: 'idle', emotion: 'curious' }), 100);
    m = reduceCursorEvent(m, ev({ state: 'idle', emotion: 'curious' }), 2600);
    expect(m.a1).toMatchObject({ emotion: 'curious', emotionAt: 2600, seenAt: 2600 });
    expect(pruneStaleCursors(m, 2600 + CURSOR_EMOTION_MS - 1).a1.emotion).toBe('curious');
  });
  it('an initial emotion event without a label replaces the previous label', () => {
    let m = reduceCursorEvent({}, ev({ state: 'click', label: 'Clicking' }), 0);
    m = reduceCursorEvent(m, ev({ state: 'idle', emotion: 'thinking' }), 10);
    expect(m.a1.event.label).toBeUndefined();
  });

  const ask = (over: Partial<AgentCursorEvent> = {}) =>
    ev({
      state: 'idle',
      emotion: 'curious',
      label: 'Which file?',
      emotionUpdate: 'start',
      ...over,
    });
  const settle = () => ev({ state: 'idle', emotion: 'neutral', emotionUpdate: 'settle' });

  it('question -> action -> renew: the action label stays and the face is refreshed', () => {
    let m = reduceCursorEvent({}, ask(), 100);
    m = reduceCursorEvent(m, ev({ state: 'move', label: 'Opening Settings', x: 50 }), 200);
    m = reduceCursorEvent(m, ask({ emotionUpdate: 'renew' }), 2600);

    expect(m.a1).toMatchObject({ emotion: 'curious', emotionAt: 2600, seenAt: 2600 });
    expect(m.a1.event).toMatchObject({ state: 'move', label: 'Opening Settings', x: 50 });
  });

  it('question -> settle: the unanswered question label is cleared', () => {
    let m = reduceCursorEvent({}, ask(), 100);
    m = reduceCursorEvent(m, ask({ emotionUpdate: 'renew' }), 2600);
    expect(m.a1.event.label).toBe('Which file?');
    m = reduceCursorEvent(m, settle(), 3000);

    expect(m.a1.emotion).toBeUndefined();
    expect(m.a1.event.label).toBeUndefined();
    expect(m.a1.seenAt).toBe(3000);
  });

  it('question -> action -> settle: the action label stays and the face goes neutral', () => {
    let m = reduceCursorEvent({}, ask(), 100);
    m = reduceCursorEvent(m, ev({ state: 'click', label: 'Selecting Downloads' }), 200);
    m = reduceCursorEvent(m, settle(), 300);

    expect(m.a1.emotion).toBeUndefined();
    expect(m.a1.event).toMatchObject({ state: 'click', label: 'Selecting Downloads' });
    expect(m.a1.seenAt).toBe(300);
  });

  it('settle still clears the question after its face expired unrenewed', () => {
    let m = reduceCursorEvent({}, ask(), 0);
    m = pruneStaleCursors(m, CURSOR_EMOTION_MS);
    expect(m.a1.event.label).toBe('Which file?');
    m = reduceCursorEvent(m, settle(), CURSOR_EMOTION_MS + 1);
    expect(m.a1.event.label).toBeUndefined();
  });

  it('the first Ask emission and a renew with no prior entry both show the question', () => {
    const first = reduceCursorEvent({}, ask(), 100);
    expect(first.a1.event.label).toBe('Which file?');
    expect(first.a1.emotion).toBe('curious');
    const renewOnly = reduceCursorEvent({}, ask({ emotionUpdate: 'renew' }), 100);
    expect(renewOnly.a1.event.label).toBe('Which file?');
    expect(renewOnly.a1.emotion).toBe('curious');
  });

  it('an idle event with no emotion drops ownership, so a later settle keeps it', () => {
    let m = reduceCursorEvent({}, ask(), 100);
    m = reduceCursorEvent(m, ev({ state: 'idle', label: 'Thinking it over' }), 200);
    m = reduceCursorEvent(m, settle(), 300);
    expect(m.a1.event.label).toBe('Thinking it over');
  });

  it('approval/permission prompts (action events with a label, no emotionUpdate) are unchanged', () => {
    let m = reduceCursorEvent({}, ask(), 100);
    m = reduceCursorEvent(
      m,
      ev({ state: 'idle', emotion: 'curious', label: 'Needs your approval' }),
      200
    );
    expect(m.a1).toMatchObject({ emotion: 'curious', emotionAt: 200 });
    expect(m.a1.event.label).toBe('Needs your approval');
    // Untagged emotion events are not emotion-owned: a settle won't erase them.
    m = reduceCursorEvent(m, settle(), 300);
    expect(m.a1.event.label).toBe('Needs your approval');
    // Untagged neutral still resets outright, as before.
    m = reduceCursorEvent(m, ev({ state: 'idle', emotion: 'neutral' }), 400);
    expect(m.a1.event.label).toBeUndefined();
  });
});

describe('flower hide and park', () => {
  const s1 = (over: Partial<AgentCursorEvent> = {}) => ev({ session: 's1', ...over });

  it('a hidden flower stays hidden for the rest of its session, even on events that predate it', () => {
    let m = reduceCursorEvent({}, s1(), 0);
    m = dismissFlower(m, 'a1');
    m = reduceCursorEvent(m, s1({ x: 99 }), 10);
    expect(m.a1.dismissed).toBe(true);
    expect(m.a1.event.x).toBe(99);
  });

  it('a new session (after a hidden event, idle expiry or a server-side expiry) shows it again', () => {
    let m = dismissFlower(reduceCursorEvent({}, s1(), 0), 'a1');
    m = reduceCursorEvent(m, ev({ session: 's2' }), 10);
    expect(m.a1.dismissed).toBeUndefined();
    m = dismissFlower(m, 'a1');
    m = reduceCursorEvent(m, ev({ state: 'hidden' }), 20);
    expect(m.a1).toBeUndefined();
    expect(reduceCursorEvent(m, ev({ session: 's2' }), 30).a1.dismissed).toBeUndefined();
    const stale = dismissFlower(reduceCursorEvent({}, s1(), 0), 'a1');
    expect(pruneStaleCursors(stale, 120_000)).toEqual({});
  });

  it('an overlay that joins mid-session takes the choice from the event', () => {
    const m = reduceCursorEvent({}, s1({ dismissed: true, parkedAt: { x: 5, y: 6 } }), 0);
    expect(m.a1).toMatchObject({ dismissed: true, parkedAt: { x: 5, y: 6 } });
  });

  it('a local park wins over the older spot an in-flight event still carries', () => {
    let m = reduceCursorEvent({}, s1({ parkedAt: { x: 1, y: 1 } }), 0);
    m = parkFlower(m, 'a1', { x: 50, y: 60 });
    m = reduceCursorEvent(m, s1({ parkedAt: { x: 1, y: 1 } }), 10);
    expect(m.a1.parkedAt).toEqual({ x: 50, y: 60 });
  });

  it('applies a broadcast choice for the same session only', () => {
    const m = reduceCursorEvent({}, s1(), 0);
    const other = { agentId: 'a1', session: 's0', dismissed: true, parkedAt: null };
    expect(applyFlowerUpdate(m, other)).toBe(m);
    expect(applyFlowerUpdate(m, { ...other, agentId: 'nobody', session: 's1' })).toBe(m);
    const parked = applyFlowerUpdate(m, {
      agentId: 'a1',
      session: 's1',
      dismissed: false,
      parkedAt: { x: 7, y: 8 },
    });
    expect(parked.a1).toMatchObject({ parkedAt: { x: 7, y: 8 } });
    expect(parked.a1.dismissed).toBeUndefined();
    expect(applyFlowerUpdate(parked, { ...other, session: 's1' }).a1.dismissed).toBe(true);
  });

  it('prune keeps the choice while it strips an expired face', () => {
    let m = reduceCursorEvent({}, s1({ state: 'idle', emotion: 'stumped' }), 0);
    m = parkFlower(m, 'a1', { x: 3, y: 4 });
    expect(pruneStaleCursors(m, CURSOR_EMOTION_MS).a1).toMatchObject({
      parkedAt: { x: 3, y: 4 },
      session: 's1',
    });
  });

  it('viewportToScreen undoes screenToViewport inside the viewport', () => {
    const v = { screenX: 100, screenY: 50, outerHeight: 800, innerHeight: 760, innerWidth: 1000 };
    const p = screenToViewport(400, 300, v);
    expect(viewportToScreen(p.x, p.y, v)).toEqual({ x: 400, y: 300 });
  });
});

describe('flower takes the mouse only once settled', () => {
  it('waits the settle time after any action, plus its glide', () => {
    let m = reduceCursorEvent({}, ev({ session: 's1' }), 0);
    expect(isFlowerInteractive(m.a1, FLOWER_SETTLE_MS - 1)).toBe(false);
    expect(isFlowerInteractive(m.a1, FLOWER_SETTLE_MS)).toBe(true);
    m = reduceCursorEvent(m, ev({ session: 's1', x: 300 }), 5000);
    expect(isFlowerInteractive(m.a1, 5000)).toBe(false);
    m = reduceCursorEvent(m, ev({ session: 's1', glideMs: 2000 }), 10_000);
    expect(isFlowerInteractive(m.a1, 10_000 + FLOWER_SETTLE_MS)).toBe(false);
    expect(isFlowerInteractive(m.a1, 12_000 + FLOWER_SETTLE_MS)).toBe(true);
  });

  it('emotion refreshes keep a settled flower settled', () => {
    let m = reduceCursorEvent({}, ev({ session: 's1', state: 'idle' }), 0);
    m = reduceCursorEvent(
      m,
      ev({ session: 's1', state: 'idle', emotion: 'thinking', emotionUpdate: 'renew' }),
      FLOWER_SETTLE_MS
    );
    expect(isFlowerInteractive(m.a1, FLOWER_SETTLE_MS)).toBe(true);
  });

  it('a new session starts unsettled even on an emotion refresh', () => {
    let m = reduceCursorEvent({}, ev({ session: 's1', state: 'idle' }), 0);
    m = reduceCursorEvent(
      m,
      ev({ session: 's2', state: 'idle', emotion: 'thinking', emotionUpdate: 'start' }),
      5000
    );
    expect(isFlowerInteractive(m.a1, 5000)).toBe(false);
  });

  it('a flower left in the click state can be grabbed once settled; a hidden one never', () => {
    const clicked = reduceCursorEvent({}, ev({ state: 'click' }), 0);
    expect(isFlowerInteractive(clicked.a1, FLOWER_SETTLE_MS)).toBe(true);
    const hidden = dismissFlower(reduceCursorEvent({}, ev({ state: 'idle' }), 0), 'a1');
    expect(isFlowerInteractive(hidden.a1, 60_000)).toBe(false);
  });

  it("another agent's action holds every flower for its settle time", () => {
    const m = reduceCursorEvent({}, ev({ session: 's1' }), 0);
    let until = nextSettleUntil(0, ev({ session: 's1' }), 0);
    expect(isFlowerInteractive(m.a1, 5000, until)).toBe(true);
    until = nextSettleUntil(until, ev({ agentId: 'a2', session: 's2', glideMs: 500 }), 5000);
    expect(until).toBe(5000 + FLOWER_SETTLE_MS + 500);
    expect(isFlowerInteractive(m.a1, until - 1, until)).toBe(false);
    expect(isFlowerInteractive(m.a1, until, until)).toBe(true);
    // Emotion refreshes from any agent leave it alone.
    const renew = ev({ agentId: 'a2', state: 'idle', emotion: 'thinking', emotionUpdate: 'renew' });
    expect(nextSettleUntil(until, renew, until + 10)).toBe(until);
    expect(nextSettleAt(m, 5000, until)).toBe(until);
  });

  it('a reconnect holds every flower again', () => {
    expect(settleAfterReconnect(0, 9000)).toBe(9000 + FLOWER_SETTLE_MS);
    expect(settleAfterReconnect(20_000, 9000)).toBe(20_000);
  });

  it('a flower kept up only by an open question no longer takes the mouse', () => {
    const m = reduceCursorEvent({}, ev({ session: 's1' }), 0);
    const kept = { ...m.a1, seenAt: CURSOR_SESSION_IDLE_MS + 10 };
    expect(isFlowerInteractive(kept, CURSOR_SESSION_IDLE_MS - 1)).toBe(true);
    expect(isFlowerInteractive(kept, CURSOR_SESSION_IDLE_MS)).toBe(false);
  });

  it('nextSettleAt names the soonest unsettled flower', () => {
    let m = reduceCursorEvent({}, ev(), 0);
    m = reduceCursorEvent(m, ev({ agentId: 'a2' }), 300);
    expect(nextSettleAt(m, 100)).toBe(FLOWER_SETTLE_MS);
    expect(nextSettleAt(m, FLOWER_SETTLE_MS)).toBe(300 + FLOWER_SETTLE_MS);
    expect(nextSettleAt(m, 300 + FLOWER_SETTLE_MS)).toBeNull();
  });
});

describe('applyFlowerSnapshot', () => {
  const live = (over: Record<string, unknown> = {}) => ({
    agentId: 'a1',
    session: 's1',
    dismissed: false,
    parkedAt: null,
    systemOverlay: false,
    ...over,
  });

  it('drops flowers whose session ended and takes the live sessions’ choices', () => {
    let m = reduceCursorEvent({}, ev({ session: 's1' }), 0);
    m = reduceCursorEvent(m, ev({ agentId: 'a2', session: 'old' }), 0);
    const next = applyFlowerSnapshot(
      m,
      [live({ parkedAt: { x: 9, y: 9 } }), live({ agentId: 'a2', session: 'new' })],
      false
    );
    expect(Object.keys(next)).toEqual(['a1']);
    expect(next.a1.parkedAt).toEqual({ x: 9, y: 9 });
  });

  it('keeps a local hide, and in the app window drops flowers the system overlay draws', () => {
    const m = dismissFlower(reduceCursorEvent({}, ev({ session: 's1' }), 0), 'a1');
    expect(applyFlowerSnapshot(m, [live()], false).a1.dismissed).toBe(true);
    expect(applyFlowerSnapshot(m, [live({ systemOverlay: true })], false)).toEqual({});
    expect(applyFlowerSnapshot(m, [live({ systemOverlay: true })], true).a1).toBeDefined();
  });
});
