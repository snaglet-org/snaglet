/**
 * useVoiceSession — state machine over a mocked WS client and injected audio
 * fakes (no AudioContext/getUserMedia under jsdom). Covers: session start +
 * timeout revert, PTT capture flow, playback-done emission, barge-in flush, and
 * speakable error handling.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsMessage } from '@snaglet/shared/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const wsHolder = vi.hoisted(() => ({
  handler: null as ((raw: WsMessage) => void) | null,
  send: vi.fn(),
  connectionState: 'open' as 'connecting' | 'open' | 'closed' | 'error',
}));

vi.mock('@desktop/ws/useWs.js', () => ({
  useWs: () => ({
    send: wsHolder.send,
    addMessageListener: (h: (raw: WsMessage) => void) => {
      wsHolder.handler = h;
      return () => {
        if (wsHolder.handler === h) wsHolder.handler = null;
      };
    },
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    connectionState: wsHolder.connectionState,
    lastMessage: null,
  }),
}));

const toastHolder = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/toast.js', () => ({ showToast: toastHolder.showToast }));

const busHolder = vi.hoisted(() => ({ emitVoiceComposer: vi.fn() }));
vi.mock('./voiceDraftBus.js', () => ({ emitVoiceComposer: busHolder.emitVoiceComposer }));

import { useVoiceSession } from './useVoiceSession';
import type { VoiceSessionDeps } from './voiceTypes';
import type { VoiceMode } from './voiceConstants';

const THREAD = 'thread-1';

function push(type: string, payload: Record<string, unknown>, channel: string | null = THREAD) {
  act(() => {
    wsHolder.handler?.({ type, ...(channel ? { channel } : {}), payload } as WsMessage);
  });
}

type DeviceChange = { reason: 'track-ended' | 'devicechange'; label: string };

function makeHarness() {
  let micOnChunk: ((b64: string, sampleRate: number) => void) | null = null;
  let micOnDeviceLabel: ((label: string) => void) | null = null;
  let micOnDeviceChange: ((info: DeviceChange) => void) | null = null;
  let resolveMicStart: (() => void) | null = null;
  let rejectMicStart: ((err: unknown) => void) | null = null;
  const mic = {
    start: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveMicStart = resolve;
          rejectMicStart = reject;
        })
    ),
    stop: vi.fn(),
  };
  const createMic = vi.fn(
    (opts: {
      onChunk: (b64: string, sampleRate: number) => void;
      onDeviceLabel?: (label: string) => void;
      onDeviceChange?: (info: DeviceChange) => void;
      onWarning?: (err: unknown) => void;
    }) => {
      micOnChunk = opts.onChunk;
      micOnDeviceLabel = opts.onDeviceLabel ?? null;
      micOnDeviceChange = opts.onDeviceChange ?? null;

      return mic;
    }
  );

  let onUtteranceDone: ((id: string) => void) | null = null;
  const playback = {
    // Accepted by default (matches real PlaybackQueue's happy path); tests of
    // the deadIds fence override with mockReturnValueOnce(false).
    enqueueChunk: vi.fn(() => true),
    markEnd: vi.fn(),
    flush: vi.fn(() => ({ utteranceId: 'u1', charOffset: 7 })),
    isSpeaking: vi.fn(() => false),
    pause: vi.fn(() => ({ utteranceId: 'u1', charOffset: 7, playedMs: 500 })),
    resume: vi.fn(),
    dispose: vi.fn(),
  };
  const createPlayback = vi.fn((opts: { onUtteranceDone: (id: string) => void }) => {
    onUtteranceDone = opts.onUtteranceDone;
    return playback;
  });

  const earcons = { thinkingTick: vi.fn(), error: vi.fn(), dispose: vi.fn() };
  const createEarcons = vi.fn(() => earcons);

  const deps: Partial<VoiceSessionDeps> = {
    createMic,
    createPlayback,
    createEarcons,
    now: () => 0,
  };
  return {
    deps,
    mic,
    playback,
    earcons,
    createMic,
    createPlayback,
    fireChunk: (b64: string, sampleRate = 16_000) => act(() => micOnChunk?.(b64, sampleRate)),
    fireDone: (id: string) => act(() => onUtteranceDone?.(id)),
    fireDeviceLabel: (label: string) => act(() => micOnDeviceLabel?.(label)),
    fireDeviceChange: (info: DeviceChange) => act(() => micOnDeviceChange?.(info)),
    fireMicReady: async () => {
      await act(async () => resolveMicStart?.());
    },
    fireMicError: async (err: unknown) => {
      await act(async () => rejectMicStart?.(err));
    },
  };
}

/** requestId of the most recent voice:session:start the hook sent. */
function lastStartRequestId(): string {
  const starts = wsHolder.send.mock.calls
    .map((c) => c[0] as { type: string; payload: { requestId?: string } })
    .filter((m) => m.type === 'voice:session:start');
  return starts[starts.length - 1]!.payload.requestId!;
}

function startSession(h: ReturnType<typeof makeHarness>) {
  const view = renderHook(() => useVoiceSession(THREAD, { deps: h.deps }));
  act(() => view.result.current.start());
  push('voice:session:started', { voiceSessionId: 'vs1' });
  return view;
}

beforeEach(() => {
  wsHolder.handler = null;
  wsHolder.send.mockReset();
  wsHolder.connectionState = 'open';
  toastHolder.showToast.mockReset();
  busHolder.emitVoiceComposer.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useVoiceSession — lifecycle', () => {
  it('start sends voice:session:start and enters connecting', () => {
    const h = makeHarness();
    const { result } = renderHook(() => useVoiceSession(THREAD, { deps: h.deps }));
    act(() => result.current.start());
    expect(result.current.phase).toBe('connecting');
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:start',
      payload: { threadId: THREAD, mode: 'ptt', requestId: expect.any(String) },
    });
  });

  it('session:started transitions to idle and records the id', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    expect(result.current.phase).toBe('idle');
    expect(result.current.voiceSessionId).toBe('vs1');
  });

  it('reverts and toasts when session:started does not arrive in time', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { result } = renderHook(() => useVoiceSession(THREAD, { deps: h.deps }));
    act(() => result.current.start());
    expect(result.current.phase).toBe('connecting');
    act(() => vi.advanceTimersByTime(10_000));
    expect(toastHolder.showToast).toHaveBeenCalledWith(
      "Voice didn't start: Snaglet's server didn't answer. Try again in a moment.",
      { durationMs: 6000 }
    );
    expect(result.current.phase).toBe('off');
  });

  it('carries selected pill targets on session:start', () => {
    const h = makeHarness();
    const { result } = renderHook(() =>
      useVoiceSession(THREAD, { deps: h.deps, targetAgentIds: ['a1', 'a2'] })
    );
    act(() => result.current.start());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:start',
      payload: {
        threadId: THREAD,
        mode: 'ptt',
        requestId: expect.any(String),
        targetAgentIds: ['a1', 'a2'],
      },
    });
  });
});

describe('useVoiceSession — composer attachments', () => {
  it('carries attached image ids on session:start so a voice send includes them', () => {
    const h = makeHarness();
    const { result } = renderHook(() =>
      useVoiceSession(THREAD, { deps: h.deps, attachmentImageIds: ['image-1', 'image-2'] })
    );
    act(() => result.current.start());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:start',
      payload: {
        threadId: THREAD,
        mode: 'ptt',
        requestId: expect.any(String),
        attachmentImageIds: ['image-1', 'image-2'],
      },
    });
  });

  it('carries images AND files (any attachment ids) together', () => {
    const h = makeHarness();
    const { result } = renderHook(() =>
      useVoiceSession(THREAD, { deps: h.deps, attachmentImageIds: ['image-9', 'file-3'] })
    );
    act(() => result.current.start());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:start',
      payload: {
        threadId: THREAD,
        mode: 'ptt',
        requestId: expect.any(String),
        attachmentImageIds: ['image-9', 'file-3'],
      },
    });
  });

  it('omits attachmentImageIds on session:start for a text-only voice send', () => {
    const h = makeHarness();
    const { result } = renderHook(() => useVoiceSession(THREAD, { deps: h.deps }));
    act(() => result.current.start());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:start',
      payload: { threadId: THREAD, mode: 'ptt', requestId: expect.any(String) },
    });
    expect(wsHolder.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice:attachments:set' })
    );
  });

  it('syncs voice:attachments:set when an image is attached mid-session (during voice input)', () => {
    const h = makeHarness();
    const view = renderHook(
      ({ ids }: { ids: string[] }) =>
        useVoiceSession(THREAD, { deps: h.deps, attachmentImageIds: ids }),
      { initialProps: { ids: [] as string[] } }
    );
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });
    wsHolder.send.mockClear();

    // User attaches an image after the session is live — it must reach the server.
    view.rerender({ ids: ['image-42'] });
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:attachments:set',
      payload: { voiceSessionId: 'vs1', attachmentImageIds: ['image-42'] },
    });
  });

  it('does not send voice:attachments:set before a session is active, but rides session:start', () => {
    const h = makeHarness();
    const view = renderHook(
      ({ ids }: { ids: string[] }) =>
        useVoiceSession(THREAD, { deps: h.deps, attachmentImageIds: ids }),
      { initialProps: { ids: [] as string[] } }
    );
    // Attach an image before starting: no session id yet → nothing on the wire…
    view.rerender({ ids: ['image-7'] });
    expect(wsHolder.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice:attachments:set' })
    );
    // …then it rides the eventual session:start.
    act(() => view.result.current.start());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:start',
      payload: {
        threadId: THREAD,
        mode: 'ptt',
        requestId: expect.any(String),
        attachmentImageIds: ['image-7'],
      },
    });
  });
});

describe('useVoiceSession — PTT capture', () => {
  it('press captures + streams chunks with incrementing seq; release ends the utterance', () => {
    const h = makeHarness();
    const { result } = startSession(h);

    act(() => result.current.pttPress());
    expect(result.current.capturing).toBe(true);
    expect(result.current.phase).toBe('listening');
    expect(h.createMic).toHaveBeenCalledTimes(1);
    expect(h.mic.start).toHaveBeenCalled();

    h.fireChunk('AAA0');
    h.fireChunk('BBB1');
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:audio:chunk',
      payload: { voiceSessionId: 'vs1', seq: 0, pcm16: 'AAA0', sampleRate: 16_000 },
    });
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:audio:chunk',
      payload: { voiceSessionId: 'vs1', seq: 1, pcm16: 'BBB1', sampleRate: 16_000 },
    });

    act(() => result.current.pttRelease());
    // Hot mic: release closes transmission but leaves the device open.
    expect(h.mic.stop).not.toHaveBeenCalled();
    expect(result.current.capturing).toBe(false);
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:utterance:end',
      payload: { voiceSessionId: 'vs1' },
    });
  });

  it('drops chunks that arrive after release (capture gate)', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    act(() => result.current.pttPress());
    act(() => result.current.pttRelease());
    wsHolder.send.mockClear();
    h.fireChunk('late');
    expect(wsHolder.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice:audio:chunk' })
    );
  });
});

describe('useVoiceSession — hot mic (session-owned device)', () => {
  it('opens the mic once for the session; press/release neither re-open nor close it', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    // The device opens when the session goes active — not on the first press,
    // so there's no getUserMedia warm-up window between press and first chunk.
    expect(h.createMic).toHaveBeenCalledTimes(1);
    expect(h.mic.start).toHaveBeenCalledTimes(1);

    act(() => result.current.pttPress());
    act(() => result.current.pttRelease());
    act(() => result.current.pttPress());
    act(() => result.current.pttRelease());

    // Two full PTT cycles: still exactly one device, never stopped.
    expect(h.createMic).toHaveBeenCalledTimes(1);
    expect(h.mic.start).toHaveBeenCalledTimes(1);
    expect(h.mic.stop).not.toHaveBeenCalled();
  });

  it('tears the device down on session stop', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    act(() => result.current.pttPress());
    act(() => result.current.pttRelease());
    expect(h.mic.stop).not.toHaveBeenCalled();

    act(() => result.current.stop());
    expect(h.mic.stop).toHaveBeenCalled();
  });

  it('tears the device down on unmount', () => {
    const h = makeHarness();
    const view = startSession(h);
    expect(h.mic.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(h.mic.stop).toHaveBeenCalled();
  });
});

describe('useVoiceSession — PTT pre-roll ring', () => {
  it('rings trailing chunks while idle (bounded) and flushes them in order on press', () => {
    const h = makeHarness();
    const { result } = startSession(h);

    // Five ~100ms chunks arrive before the press — only the last three survive.
    h.fireChunk('c0');
    h.fireChunk('c1');
    h.fireChunk('c2');
    h.fireChunk('c3');
    h.fireChunk('c4');
    // Nothing is transmitted while idle.
    expect(wsHolder.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice:audio:chunk' })
    );

    act(() => result.current.pttPress());
    // Ring (c2,c3,c4) flushes first with seq 0,1,2 …
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:audio:chunk',
      payload: { voiceSessionId: 'vs1', seq: 0, pcm16: 'c2', sampleRate: 16_000 },
    });
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:audio:chunk',
      payload: { voiceSessionId: 'vs1', seq: 1, pcm16: 'c3', sampleRate: 16_000 },
    });
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:audio:chunk',
      payload: { voiceSessionId: 'vs1', seq: 2, pcm16: 'c4', sampleRate: 16_000 },
    });
    // The two oldest fell out of the bounded ring.
    expect(wsHolder.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ pcm16: 'c0' }) })
    );
    expect(wsHolder.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ pcm16: 'c1' }) })
    );

    // … then live chunks continue the same per-utterance seq.
    h.fireChunk('live');
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:audio:chunk',
      payload: { voiceSessionId: 'vs1', seq: 3, pcm16: 'live', sampleRate: 16_000 },
    });
  });

  it('resets seq and ring per press: no leak across a release', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    act(() => result.current.pttPress());
    h.fireChunk('u1a'); // transmitted live during the first hold, never ringed
    act(() => result.current.pttRelease());
    wsHolder.send.mockClear();

    // One idle chunk lands in the ring; the next press flushes just it at seq 0.
    h.fireChunk('roll');
    act(() => result.current.pttPress());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:audio:chunk',
      payload: { voiceSessionId: 'vs1', seq: 0, pcm16: 'roll', sampleRate: 16_000 },
    });
    expect(wsHolder.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ pcm16: 'u1a' }) })
    );
  });

  it('open mode forwards continuously — no ring, no press needed', () => {
    const h = makeHarness();
    const view = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, mode: 'open' }));
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });

    // A chunk before any "press" is transmitted immediately, not held in a ring.
    h.fireChunk('o0');
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:audio:chunk',
      payload: { voiceSessionId: 'vs1', seq: 0, pcm16: 'o0', sampleRate: 16_000 },
    });
  });
});

describe('useVoiceSession — playback', () => {
  it('enqueues tts chunks, marks speaking, and emits playback:done', () => {
    const h = makeHarness();
    const { result } = startSession(h);

    push('voice:tts:chunk', { utteranceId: 'u1', agentId: 'a1', seq: 0, pcm16: 'zz' });
    expect(result.current.agentSpeaking).toBe(true);
    expect(result.current.phase).toBe('agent-speaking');
    expect(h.playback.enqueueChunk).toHaveBeenCalledWith({
      utteranceId: 'u1',
      agentId: 'a1',
      seq: 0,
      pcm16: 'zz',
    });

    push('voice:tts:end', { utteranceId: 'u1' });
    expect(h.playback.markEnd).toHaveBeenCalledWith('u1');

    h.fireDone('u1');
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:playback:done',
      payload: { voiceSessionId: 'vs1', utteranceId: 'u1' },
    });
    expect(result.current.agentSpeaking).toBe(false);
  });

  it('tracks the floor holder', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    push('voice:floor', { holder: 'a2' });
    expect(result.current.floorHolder).toBe('a2');
    push('voice:floor', { holder: null });
    expect(result.current.floorHolder).toBeNull();
  });
});

describe('useVoiceSession — converging preview → composer', () => {
  it('stashes on press and streams the converging transcript (quality sticky, live tail)', () => {
    const h = makeHarness();
    const { result } = startSession(h);

    // Press stashes the typed draft (composer bus: start) before any partial.
    act(() => result.current.pttPress());
    expect(busHolder.emitVoiceComposer).toHaveBeenCalledWith({ kind: 'start', threadId: THREAD });

    // A live partial extends the tail…
    push('voice:partial', { text: 'the quick', tier: 'live' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'update',
      threadId: THREAD,
      text: 'the quick',
      isRevising: false,
    });

    // …a quality upgrade replaces the covered words (authoritative, sticky) —
    // but it's the first quality tier, so nothing was revised (not flagged).
    push('voice:partial', { text: 'The quick brown', tier: 'quality' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'update',
      threadId: THREAD,
      text: 'The quick brown',
      isRevising: false,
    });

    // …and a longer live partial extends only the tail beyond the quality words.
    push('voice:partial', { text: 'the quick brown fox jumps', tier: 'live' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'update',
      threadId: THREAD,
      text: 'The quick brown fox jumps',
      isRevising: false,
    });
  });

  it('flags isRevising when a quality re-decode changes already-shown words', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    act(() => result.current.pttPress());

    // First quality re-decode — nothing shown before it, so not a revision.
    push('voice:partial', { text: 'I scream', tier: 'quality' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'update',
      threadId: THREAD,
      text: 'I scream',
      isRevising: false,
    });

    // Apple re-evaluates the same audio — the earlier words churn ("I scream" →
    // "ice cream"). That's a revision, not a tail extension → flagged.
    push('voice:partial', { text: 'ice cream', tier: 'quality' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'update',
      threadId: THREAD,
      text: 'ice cream',
      isRevising: true,
    });

    // A further quality re-decode that only extends the tail leaves the shown
    // words intact → not flagged.
    push('voice:partial', { text: 'ice cream cone', tier: 'quality' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'update',
      threadId: THREAD,
      text: 'ice cream cone',
      isRevising: false,
    });
  });

  it('treats a tierless partial as live (back-compat)', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    act(() => result.current.pttPress());
    push('voice:partial', { text: 'no tier here' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'update',
      threadId: THREAD,
      text: 'no tier here',
      isRevising: false,
    });
  });

  it('settles the composer on the dispatched final', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    act(() => result.current.pttPress());
    push('voice:partial', { text: 'the quick brown fox', tier: 'quality' });
    act(() => result.current.pttRelease());

    push('voice:final', { text: 'the quick brown fox', messageId: 'm1' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'settle',
      threadId: THREAD,
      text: 'the quick brown fox',
    });
  });

  it('reverts the composer on a no-dispatch (empty) final — backchannel', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    act(() => result.current.pttPress());
    push('voice:partial', { text: 'mhm', tier: 'live' });

    push('voice:final', { text: '', messageId: null });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'revert',
      threadId: THREAD,
    });
  });
});

describe('useVoiceSession — cross-utterance bleed (open-mic, late voice:final)', () => {
  function startOpen(h: ReturnType<typeof makeHarness>) {
    const view = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, mode: 'open' }));
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });
    return view;
  }
  const lastUpdate = (): string => {
    const calls = busHolder.emitVoiceComposer.mock.calls.map((c) => c[0]);
    const updates = calls.filter((c) => c.kind === 'update');
    return updates.length ? (updates[updates.length - 1]!.text as string) : '';
  };

  // Key ordering: utterance A is sent, then B's partials arrive before A's
  // voice:final (which can land seconds late on the barge-in path). The tier
  // state must reset on B's partials, not wait for A's final, or B renders as
  // A's stale quality tier plus B's live tail. Partials and finals carry a
  // per-utterance `utteranceSeq` key.
  it('does NOT render utterance A when utterance B partials arrive before A final', () => {
    const h = makeHarness();
    startOpen(h);

    // Utterance A (seq 1): live then an authoritative quality upgrade.
    push('voice:partial', { text: 'the weather', tier: 'live', utteranceSeq: 1 });
    push('voice:partial', {
      text: 'The weather in Boston is cold and rainy today.',
      tier: 'quality',
      utteranceSeq: 1,
    });
    expect(lastUpdate()).toBe('The weather in Boston is cold and rainy today.');

    // A dispatched — but its voice:final has not arrived yet (late on the wire).
    // Utterance B starts and its first live partial arrives.
    push('voice:partial', { text: 'please schedule a', tier: 'live', utteranceSeq: 2 });

    // The composer must show utterance B — never A's stale quality tier bleeding
    // in front of it ("the full message from the beginning").
    const shown = lastUpdate();
    expect(shown).not.toMatch(/weather|Boston|rainy/i);
    expect(shown).toBe('please schedule a');
  });

  // A stale voice:final for the superseded utterance A, arriving after B is
  // already being captured, must not clobber B's live composer.
  it('ignores a stale (superseded) voice:final that arrives during the next utterance', () => {
    const h = makeHarness();
    startOpen(h);

    push('voice:partial', {
      text: 'The weather in Boston is cold and rainy today.',
      tier: 'quality',
      utteranceSeq: 1,
    });
    // B begins before A's final.
    push('voice:partial', { text: 'please schedule a meeting', tier: 'live', utteranceSeq: 2 });
    expect(lastUpdate()).toBe('please schedule a meeting');

    // A's late final lands now (seq 1) — it is stale; B (seq 2) is live.
    busHolder.emitVoiceComposer.mockClear();
    push('voice:final', {
      text: 'The weather in Boston is cold and rainy today.',
      messageId: 'mA',
      utteranceSeq: 1,
    });
    // It must not settle/overwrite the composer onto A's text.
    const settles = busHolder.emitVoiceComposer.mock.calls
      .map((c) => c[0])
      .filter((c) => c.kind === 'settle');
    expect(settles).toHaveLength(0);
    // B is still the shown utterance.
    push('voice:partial', {
      text: 'please schedule a meeting today',
      tier: 'live',
      utteranceSeq: 2,
    });
    expect(lastUpdate()).toBe('please schedule a meeting today');
  });
});

describe('useVoiceSession — barge-in', () => {
  it('flushes playback and sends voice:bargein with heardUpTo when pressing over a speaker', () => {
    const h = makeHarness();
    h.playback.isSpeaking.mockReturnValue(true);
    const { result } = startSession(h);

    push('voice:tts:chunk', { utteranceId: 'u1', agentId: 'a1', seq: 0, pcm16: 'zz' });
    expect(result.current.agentSpeaking).toBe(true);

    act(() => result.current.pttPress());
    expect(h.playback.flush).toHaveBeenCalledTimes(1);
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:bargein',
      payload: { voiceSessionId: 'vs1', heardUpTo: { utteranceId: 'u1', charOffset: 7 } },
    });
    // Playback stopped; the interrupting utterance is being captured.
    expect(result.current.agentSpeaking).toBe(false);
    expect(result.current.capturing).toBe(true);
  });

  it('a fenced straggler ttsChunk after flush does not leave agentSpeaking/phase stuck true', () => {
    // Covers the PlaybackQueue deadIds fence: the server's synthesis abort is
    // checked between frames, not instantly, so a chunk already in flight when
    // flush() fires can still arrive afterward. PlaybackQueue rejects it
    // (enqueueChunk returns false) — the ttsChunk handler must respect that and
    // not re-flip agentSpeaking/re-add the id.
    const h = makeHarness();
    h.playback.isSpeaking.mockReturnValue(true);
    const { result } = startSession(h);

    push('voice:tts:chunk', { utteranceId: 'u1', agentId: 'a1', seq: 0, pcm16: 'zz' });
    expect(result.current.agentSpeaking).toBe(true);

    act(() => result.current.pttPress());
    expect(result.current.agentSpeaking).toBe(false);
    expect(result.current.phase).not.toBe('agent-speaking');

    // The straggler: PlaybackQueue's deadIds fence rejects it.
    h.playback.enqueueChunk.mockReturnValueOnce(false);
    push('voice:tts:chunk', { utteranceId: 'u1', agentId: 'a1', seq: 1, pcm16: 'straggler' });
    expect(result.current.agentSpeaking).toBe(false);
    expect(result.current.phase).not.toBe('agent-speaking');

    // Prove u1 was never re-added to speakingIdsRef: a genuine new utterance
    // (u2) finishing should fully clear agentSpeaking. If the straggler had
    // leaked u1 back into the set, its size would never reach 0 and this would
    // still show agentSpeaking === true.
    push('voice:tts:chunk', { utteranceId: 'u2', agentId: 'a1', seq: 0, pcm16: 'yy' });
    expect(result.current.agentSpeaking).toBe(true);
    h.fireDone('u2');
    expect(result.current.agentSpeaking).toBe(false);
    expect(result.current.phase).not.toBe('agent-speaking');
  });

  it('reconciles agentSpeaking on the floor-resolution flush path (real barge-in via voice:floor)', () => {
    // The floor-resolution flush (voice:interrupt → voice:floor with a
    // different/no holder) must also clear the flushed utterance's id from
    // speakingIdsRef/agentSpeaking. Otherwise the id stays in the set forever:
    // once a next speaker's utterance finished, the size would never reach 0
    // and the indicator would stay wrongly lit.
    const h = makeHarness();
    const view = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, mode: 'open' }));
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });

    push('voice:floor', { holder: 'agent1' });
    push('voice:tts:chunk', { utteranceId: 'u1', agentId: 'agent1', seq: 0, pcm16: 'zz' });
    expect(view.result.current.agentSpeaking).toBe(true);

    push('voice:interrupt', { voiceSessionId: 'vs1', utteranceId: 'u1' });
    // Real barge-in / group hand-off: a different agent takes the floor, so
    // playback.flush() runs (not the backchannel resume path).
    push('voice:floor', { holder: 'agent2' });
    expect(h.playback.flush).toHaveBeenCalledTimes(1);
    // u1's audio was discarded, not played out — onUtteranceDone will never
    // fire for it. The floor handler must reconcile immediately.
    expect(view.result.current.agentSpeaking).toBe(false);

    // agent2's genuine utterance plays and finishes — must fully clear, not get
    // stuck true from a zombied u1 entry.
    push('voice:tts:chunk', { utteranceId: 'u2', agentId: 'agent2', seq: 0, pcm16: 'yy' });
    expect(view.result.current.agentSpeaking).toBe(true);
    h.fireDone('u2');
    expect(view.result.current.agentSpeaking).toBe(false);
    expect(view.result.current.phase).not.toBe('agent-speaking');
  });
});

describe('useVoiceSession — errors + earcons', () => {
  it('voice:error plays the error earcon, surfaces the message, and toasts', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    push('voice:error', { message: 'STT crashed', speakable: true });
    expect(h.earcons.error).toHaveBeenCalled();
    expect(result.current.lastError).toBe('STT crashed');
    expect(toastHolder.showToast).toHaveBeenCalledWith('STT crashed', { durationMs: 6000 });
  });

  it('agent thinking status fires the heard-you tick only while active', () => {
    const h = makeHarness();
    // Before a session exists, a thinking status must not beep.
    renderHook(() => useVoiceSession(THREAD, { deps: h.deps }));
    push('socket:agent:status', { agentId: 'a1', status: 'thinking' });
    expect(h.earcons.thinkingTick).not.toHaveBeenCalled();
  });

  it('agent thinking status fires the heard-you tick once active', () => {
    const h = makeHarness();
    startSession(h);
    push('socket:agent:status', { agentId: 'a1', status: 'thinking' });
    expect(h.earcons.thinkingTick).toHaveBeenCalled();
  });
});

describe('useVoiceSession — Esc bail-out', () => {
  it('hold → partials → Esc → release: no dispatch, final lands in the composer', () => {
    const h = makeHarness();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, onFinal }));
    act(() => result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });

    act(() => result.current.pttPress());
    push('voice:partial', { text: 'delete everything' });
    act(() => result.current.requestBail());
    act(() => result.current.pttRelease());

    // utterance:end carries cancelDispatch so the server suppresses dispatch.
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:utterance:end',
      payload: { voiceSessionId: 'vs1', cancelDispatch: true },
    });

    // The finalized text merges into the composer (stash + transcript) via the
    // bus 'bail' signal — not the dispatch path.
    push('voice:final', { text: 'delete everything', messageId: 'm1' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'bail',
      threadId: THREAD,
      text: 'delete everything',
    });
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('normal release (no Esc) dispatches: no cancel flag, onFinal fires', () => {
    const h = makeHarness();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, onFinal }));
    act(() => result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });

    act(() => result.current.pttPress());
    act(() => result.current.pttRelease());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:utterance:end',
      payload: { voiceSessionId: 'vs1' },
    });

    push('voice:final', { text: 'hello there', messageId: 'm1' });
    expect(onFinal).toHaveBeenCalledWith({ text: 'hello there', messageId: 'm1' });
    // A normal dispatch settles the composer — it never merges a bail draft.
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'settle',
      threadId: THREAD,
      text: 'hello there',
    });
    expect(busHolder.emitVoiceComposer).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bail' })
    );
  });

  it('finalize-beat Esc (after release) sends a late cancel and still routes to the composer', () => {
    const h = makeHarness();
    const { result } = renderHook(() => useVoiceSession(THREAD, { deps: h.deps }));
    act(() => result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });

    act(() => result.current.pttPress());
    act(() => result.current.pttRelease());
    wsHolder.send.mockClear();

    act(() => result.current.requestBail());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:utterance:end',
      payload: { voiceSessionId: 'vs1', cancelDispatch: true },
    });

    push('voice:final', { text: 'never mind', messageId: 'm2' });
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'bail',
      threadId: THREAD,
      text: 'never mind',
    });
  });
});

describe('useVoiceSession — dictate/speak split', () => {
  it('omits dictate/speak from session:start when the caller never passes them (back-compat wire shape)', () => {
    const h = makeHarness();
    const { result } = renderHook(() => useVoiceSession(THREAD, { deps: h.deps }));
    act(() => result.current.start());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:start',
      payload: { threadId: THREAD, mode: 'ptt', requestId: expect.any(String) },
    });
  });

  it('carries explicit dictate/speak flags on session:start', () => {
    const h = makeHarness();
    const { result } = renderHook(() =>
      useVoiceSession(THREAD, { deps: h.deps, dictate: true, speak: false })
    );
    act(() => result.current.start());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:start',
      payload: {
        threadId: THREAD,
        mode: 'ptt',
        requestId: expect.any(String),
        dictate: true,
        speak: false,
      },
    });
  });

  it('dictate-only (speak:false): a non-empty final NEVER settles — it merges into the composer as a draft, but still notifies onFinal (not a cancel)', () => {
    const h = makeHarness();
    const onFinal = vi.fn();
    const { result } = renderHook(() =>
      useVoiceSession(THREAD, { deps: h.deps, dictate: true, speak: false, onFinal })
    );
    act(() => result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });

    act(() => result.current.pttPress());
    act(() => result.current.pttRelease());
    // No cancelDispatch — this is a normal release, not an Esc bail.
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:utterance:end',
      payload: { voiceSessionId: 'vs1' },
    });

    // The server's utteranceEnd `!state.speak` branch never dispatched this
    // (messageId stays null) but did finalize a real transcript.
    push('voice:final', { text: 'buy milk tomorrow', messageId: null });

    // Draft, not settle: the same bus mechanism as an Esc-bail merges it into
    // the composer as editable text — but this was a normal completion, so
    // onFinal still fires (unlike a genuine Esc cancel).
    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'bail',
      threadId: THREAD,
      text: 'buy milk tomorrow',
    });
    expect(onFinal).toHaveBeenCalledWith({ text: 'buy milk tomorrow', messageId: null });
  });

  it('both dictate AND speak on: a non-empty final settles as usual', () => {
    const h = makeHarness();
    const onFinal = vi.fn();
    const { result } = renderHook(() =>
      useVoiceSession(THREAD, { deps: h.deps, dictate: true, speak: true, onFinal })
    );
    act(() => result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });

    act(() => result.current.pttPress());
    act(() => result.current.pttRelease());
    push('voice:final', { text: 'ship it', messageId: 'm9' });

    expect(busHolder.emitVoiceComposer).toHaveBeenLastCalledWith({
      kind: 'settle',
      threadId: THREAD,
      text: 'ship it',
    });
    expect(onFinal).toHaveBeenCalledWith({ text: 'ship it', messageId: 'm9' });
  });

  it('re-handshakes (stop -> start) when speak flips mid-session, carrying the new flag', () => {
    const h = makeHarness();
    const view = renderHook(
      ({ speak }: { speak: boolean }) =>
        useVoiceSession(THREAD, { deps: h.deps, dictate: true, speak }),
      { initialProps: { speak: false } }
    );
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });
    wsHolder.send.mockClear();

    view.rerender({ speak: true });

    // stop() (session:stop) then a fresh start() with speak:true.
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:stop',
      payload: { voiceSessionId: 'vs1' },
    });
    const startFrame = wsHolder.send.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'voice:session:start'
    )?.[0] as { type: string; payload: unknown };
    expect(startFrame.payload).toEqual({
      threadId: THREAD,
      mode: 'ptt',
      requestId: expect.any(String),
      dictate: true,
      speak: true,
    });
  });
});

describe('useVoiceSession — open-mic (mode open)', () => {
  async function startOpen(h: ReturnType<typeof makeHarness>) {
    const view = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, mode: 'open' }));
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });
    await h.fireMicReady();
    return view;
  }

  it('dictation: a final with no partial before it APPENDS to the composer draft', async () => {
    // Apple often finalizes a short utterance before showing any partial. The
    // composer must stash what it holds (earlier dictation / typed text) first,
    // or the 'bail' merge would write the transcript over it.
    const h = makeHarness();
    const view = renderHook(() =>
      useVoiceSession(THREAD, { deps: h.deps, mode: 'open', dictate: true, speak: false })
    );
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });
    await h.fireMicReady();

    push('voice:final', { text: 'Buy milk tomorrow.', messageId: null, utteranceSeq: 1 });
    expect(busHolder.emitVoiceComposer.mock.calls.map(([evt]) => evt)).toEqual([
      { kind: 'start', threadId: THREAD },
      { kind: 'bail', threadId: THREAD, text: 'Buy milk tomorrow.' },
    ]);

    // With a partial first, the capture already stashed: no second 'start'.
    busHolder.emitVoiceComposer.mockClear();
    push('voice:partial', { text: 'Call the', tier: 'quality', utteranceSeq: 2 });
    push('voice:final', { text: 'Call the plumber.', messageId: null, utteranceSeq: 2 });
    expect(
      busHolder.emitVoiceComposer.mock.calls.map(([evt]) => (evt as { kind: string }).kind)
    ).toEqual(['start', 'update', 'bail']);
  });

  it('voice mode: a sent final with no partial before it still restores the typed draft', async () => {
    const h = makeHarness();
    const view = renderHook(() =>
      useVoiceSession(THREAD, { deps: h.deps, mode: 'open', dictate: true, speak: true })
    );
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });
    await h.fireMicReady();

    push('voice:final', { text: 'Ship it.', messageId: 'm1', utteranceSeq: 1 });
    expect(busHolder.emitVoiceComposer.mock.calls.map(([evt]) => evt)).toEqual([
      { kind: 'start', threadId: THREAD },
      { kind: 'settle', threadId: THREAD, text: 'Ship it.' },
    ]);
  });

  it('starts continuous capture on active and streams chunks (no PTT)', async () => {
    const h = makeHarness();
    const { result } = await startOpen(h);
    expect(h.mic.start).toHaveBeenCalled();
    expect(result.current.micReady).toBe(true);
    expect(result.current.phase).toBe('listening');

    h.fireChunk('AAA0');
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:audio:chunk',
      payload: { voiceSessionId: 'vs1', seq: 0, pcm16: 'AAA0', sampleRate: 16_000 },
    });
  });

  it('does not claim listening until microphone startup completes', async () => {
    const h = makeHarness();
    const view = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, mode: 'open' }));
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });

    expect(view.result.current.micReady).toBe(false);
    expect(view.result.current.phase).toBe('idle');

    await h.fireMicReady();
    expect(view.result.current.micReady).toBe(true);
    expect(view.result.current.phase).toBe('listening');
  });

  it('surfaces microphone errors and tears down the false-active session', async () => {
    const h = makeHarness();
    const view = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, mode: 'open' }));
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });
    wsHolder.send.mockClear();

    await h.fireMicError(new Error('Permission denied'));

    expect(view.result.current.phase).toBe('off');
    expect(view.result.current.micReady).toBe(false);
    expect(view.result.current.lastError).toBe("The microphone couldn't start: Permission denied");
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:stop',
      payload: { voiceSessionId: 'vs1' },
    });
    expect(toastHolder.showToast).toHaveBeenCalledWith(
      "The microphone couldn't start: Permission denied",
      { durationMs: 6000 }
    );
  });

  it('carries mode:open on session:start', () => {
    const h = makeHarness();
    const { result } = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, mode: 'open' }));
    act(() => result.current.start());
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:start',
      payload: { threadId: THREAD, mode: 'open', requestId: expect.any(String) },
    });
  });

  it('voice:interrupt pauses playback and reports playedMs via voice:bargein', () => {
    const h = makeHarness();
    startOpen(h);
    push('voice:tts:chunk', { utteranceId: 'u1', agentId: 'a1', seq: 0, pcm16: 'zz' });
    wsHolder.send.mockClear();

    push('voice:interrupt', { voiceSessionId: 'vs1', utteranceId: 'u1' });
    expect(h.playback.pause).toHaveBeenCalledTimes(1);
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:bargein',
      payload: {
        voiceSessionId: 'vs1',
        heardUpTo: { utteranceId: 'u1', charOffset: 7, playedMs: 500 },
      },
    });
  });

  it('resumes the SAME speaker without flushing when re-granted the floor (backchannel)', () => {
    const h = makeHarness();
    startOpen(h);
    push('voice:floor', { holder: 'a1' }); // a1 is speaking
    push('voice:interrupt', { voiceSessionId: 'vs1', utteranceId: 'u1' });
    push('voice:floor', { holder: 'a1' }); // server resumes the same speaker
    expect(h.playback.resume).toHaveBeenCalledTimes(1);
    expect(h.playback.flush).not.toHaveBeenCalled();
  });

  it('flushes + resumes when the floor clears after an interrupt (real barge-in)', () => {
    const h = makeHarness();
    startOpen(h);
    push('voice:interrupt', { voiceSessionId: 'vs1', utteranceId: 'u1' });
    push('voice:floor', { holder: null }); // speaker was cut
    expect(h.playback.flush).toHaveBeenCalledTimes(1);
    expect(h.playback.resume).toHaveBeenCalledTimes(1);
  });

  it('flushes stale audio when a DIFFERENT agent takes the floor after an interrupt', () => {
    const h = makeHarness();
    startOpen(h);
    push('voice:floor', { holder: 'agent1' }); // agent1 was speaking
    push('voice:interrupt', { voiceSessionId: 'vs1', utteranceId: 'u1' });
    // Real barge-in with an immediate group hand-off: agent2 takes the floor.
    push('voice:floor', { holder: 'agent2' });
    // The interrupted agent's paused buffers must not survive: flush, then resume.
    expect(h.playback.flush).toHaveBeenCalledTimes(1);
    expect(h.playback.resume).toHaveBeenCalledTimes(1);
    expect(h.playback.flush.mock.invocationCallOrder[0]).toBeLessThan(
      h.playback.resume.mock.invocationCallOrder[0]
    );
  });
});

describe('useVoiceSession — thread-level takeover (FIX 1)', () => {
  it('voice:session:ended reverts to off + toasts and does NOT reconnect', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    expect(result.current.phase).toBe('idle');
    wsHolder.send.mockClear();

    push('voice:session:ended', {
      voiceSessionId: 'vs1',
      reason: 'taken-over',
      message: 'voice session taken over by another window',
    });

    expect(result.current.phase).toBe('off');
    expect(toastHolder.showToast).toHaveBeenCalledWith(
      'voice session taken over by another window',
      { durationMs: 6000 }
    );
    // No reconnect loop: teardown sends nothing.
    expect(wsHolder.send).not.toHaveBeenCalled();
    // Device released.
    expect(h.mic.stop).toHaveBeenCalled();
  });

  it('a session the server ended because speech recognition failed turns off with the reason', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    wsHolder.send.mockClear();

    push('voice:session:ended', {
      voiceSessionId: 'vs1',
      reason: 'failed',
      message: "Dictation stopped: Apple's built-in speech recognition quit unexpectedly.",
    });

    expect(result.current.phase).toBe('off');
    expect(result.current.lastError).toBe(
      "Dictation stopped: Apple's built-in speech recognition quit unexpectedly."
    );
    expect(wsHolder.send).not.toHaveBeenCalled();
  });

  it('ignores a foreign voice:session:started while active (no id clobber)', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    expect(result.current.voiceSessionId).toBe('vs1');
    // A second window starting on this thread broadcasts its started frame to us.
    push('voice:session:started', { voiceSessionId: 'vs2' });
    // We keep our own id — not clobbered / re-activated.
    expect(result.current.voiceSessionId).toBe('vs1');
    expect(result.current.phase).toBe('idle');
  });

  it('ignores a stale voice:session:ended for an already-replaced session', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    push('voice:session:ended', { voiceSessionId: 'stale-vs', reason: 'taken-over', message: 'x' });
    expect(result.current.phase).toBe('idle'); // different id → not us → ignored
  });
});

describe('useVoiceSession — input device surfacing (FIX 2)', () => {
  it('exposes the live input device label on start', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    h.fireDeviceLabel('MacBook Pro Microphone');
    expect(result.current.inputDevice).toBe('MacBook Pro Microphone');
  });

  it('a yanked track surfaces an error + earcon and rebuilds the mic exactly once', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    expect(h.createMic).toHaveBeenCalledTimes(1);

    h.fireDeviceChange({ reason: 'track-ended', label: 'AirPods' });
    expect(h.earcons.error).toHaveBeenCalled();
    expect(toastHolder.showToast).toHaveBeenCalledWith(expect.stringContaining('AirPods'));
    expect(result.current.lastError).toContain('disconnected');
    // Hot-mic effect rebuilt the device once.
    expect(h.createMic).toHaveBeenCalledTimes(2);

    // A second yank does not spin another rebuild (capped → no reconnect loop).
    h.fireDeviceChange({ reason: 'track-ended', label: 'AirPods' });
    expect(h.createMic).toHaveBeenCalledTimes(2);
  });

  it('a devicechange (silent switch) surfaces a notice without rebuilding', () => {
    const h = makeHarness();
    const { result } = startSession(h);
    expect(h.createMic).toHaveBeenCalledTimes(1);

    h.fireDeviceChange({ reason: 'devicechange', label: 'iPhone Microphone' });
    expect(toastHolder.showToast).toHaveBeenCalledWith('Microphone changed: iPhone Microphone');
    expect(result.current.inputDevice).toBe('iPhone Microphone');
    expect(h.earcons.error).toHaveBeenCalled();
    // We never auto-switch devices on a devicechange — no rebuild.
    expect(h.createMic).toHaveBeenCalledTimes(1);
  });
});

describe('useVoiceSession — capture mode flip', () => {
  it('re-handshakes (stop → start) with the new mode when captureMode flips mid-session', async () => {
    const h = makeHarness();
    const view = renderHook(
      ({ mode }: { mode: VoiceMode }) => useVoiceSession(THREAD, { deps: h.deps, mode }),
      { initialProps: { mode: 'ptt' } }
    );
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1' });
    expect(view.result.current.phase).toBe('idle');
    wsHolder.send.mockClear();

    // Flip PTT → open while the session is live.
    view.rerender({ mode: 'open' });

    const types = wsHolder.send.mock.calls.map((c) => (c[0] as { type: string }).type);
    const stopIdx = types.indexOf('voice:session:stop');
    const startIdx = types.indexOf('voice:session:start');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx); // clean stop → start, in that order
    const startFrame = wsHolder.send.mock.calls[startIdx]![0] as { payload: unknown };
    expect(startFrame.payload).toEqual({
      threadId: THREAD,
      mode: 'open',
      requestId: expect.any(String),
    });

    // The re-handshake completes as an open-mic session.
    push('voice:session:started', { voiceSessionId: 'vs2' });
    await h.fireMicReady();
    expect(view.result.current.phase).toBe('listening');
  });
});

describe('useVoiceSession — a start that fails always says why and reports onEnded', () => {
  function renderOpen(h: ReturnType<typeof makeHarness>, onEnded = vi.fn()) {
    const view = renderHook(() => useVoiceSession(THREAD, { deps: h.deps, mode: 'open', onEnded }));
    return { view, onEnded };
  }

  it('ends the handshake at once when the server refuses this start', () => {
    const h = makeHarness();
    const { view, onEnded } = renderOpen(h);
    act(() => view.result.current.start());
    const requestId = lastStartRequestId();
    wsHolder.send.mockClear();

    push('voice:error', {
      message: "Voice input can't start: The voice detection model isn't installed.",
      speakable: false,
      requestId,
    });

    expect(view.result.current.phase).toBe('off');
    expect(view.result.current.lastError).toBe(
      "Voice input can't start: The voice detection model isn't installed."
    );
    expect(toastHolder.showToast).toHaveBeenCalledWith(
      "Voice input can't start: The voice detection model isn't installed.",
      { durationMs: 6000 }
    );
    expect(onEnded).toHaveBeenCalledOnce();
    expect(wsHolder.send).not.toHaveBeenCalled(); // no session to stop
  });

  it("ignores another window's refused start on the same thread", () => {
    const h = makeHarness();
    const { view, onEnded } = renderOpen(h);
    act(() => view.result.current.start());
    push('voice:error', { message: 'not ours', speakable: false, requestId: 'other-window' });
    expect(view.result.current.phase).toBe('connecting');
    expect(toastHolder.showToast).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("ignores another window's session:started while connecting", () => {
    const h = makeHarness();
    const { view } = renderOpen(h);
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs-other', requestId: 'other-window' });
    expect(view.result.current.phase).toBe('connecting');
    push('voice:session:started', { voiceSessionId: 'vs1', requestId: lastStartRequestId() });
    expect(view.result.current.voiceSessionId).toBe('vs1');
  });

  it('reports onEnded when the server never answers, and stops the session if it opens late', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { view, onEnded } = renderOpen(h);
    act(() => view.result.current.start());
    const requestId = lastStartRequestId();
    act(() => vi.advanceTimersByTime(10_000));
    expect(view.result.current.phase).toBe('off');
    expect(onEnded).toHaveBeenCalledOnce();
    wsHolder.send.mockClear();

    push('voice:session:started', { voiceSessionId: 'vs-late', requestId });

    expect(view.result.current.phase).toBe('off');
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:stop',
      payload: { voiceSessionId: 'vs-late' },
    });
  });

  it('stops a session whose start the user canceled while connecting', () => {
    const h = makeHarness();
    const { view, onEnded } = renderOpen(h);
    act(() => view.result.current.start());
    const requestId = lastStartRequestId();
    act(() => view.result.current.stop());
    wsHolder.send.mockClear();

    push('voice:session:started', { voiceSessionId: 'vs-late', requestId });

    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:stop',
      payload: { voiceSessionId: 'vs-late' },
    });
    expect(onEnded).not.toHaveBeenCalled(); // the user asked for this stop
  });

  it('refuses to queue a start while the socket is down', () => {
    wsHolder.connectionState = 'closed';
    const h = makeHarness();
    const { view, onEnded } = renderOpen(h);
    act(() => view.result.current.start());
    expect(wsHolder.send).not.toHaveBeenCalled();
    expect(view.result.current.phase).toBe('off');
    expect(toastHolder.showToast).toHaveBeenCalledWith(
      "Voice can't start while Snaglet is disconnected from its server. Try again in a moment.",
      { durationMs: 6000 }
    );
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('names the permission fix when the microphone is blocked', async () => {
    const h = makeHarness();
    const { view, onEnded } = renderOpen(h);
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1', requestId: lastStartRequestId() });
    const denied = new Error('The request is not allowed by the user agent');
    denied.name = 'NotAllowedError';

    await h.fireMicError(denied);

    expect(view.result.current.phase).toBe('off');
    expect(view.result.current.lastError).toMatch(/isn't allowed to use the microphone/);
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('ends the session when the microphone never starts', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { view, onEnded } = renderOpen(h);
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1', requestId: lastStartRequestId() });
    expect(view.result.current.phase).toBe('idle'); // mic still starting
    wsHolder.send.mockClear();

    act(() => vi.advanceTimersByTime(15_000));

    expect(view.result.current.phase).toBe('off');
    expect(view.result.current.lastError).toMatch(/microphone didn't start/);
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'voice:session:stop',
      payload: { voiceSessionId: 'vs1' },
    });
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('a mic that starts in time cancels the startup timeout', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { view, onEnded } = renderOpen(h);
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1', requestId: lastStartRequestId() });
    await h.fireMicReady();
    act(() => vi.advanceTimersByTime(15_000));
    expect(view.result.current.phase).toBe('listening');
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('ignores a session:ended while it holds no session', () => {
    const h = makeHarness();
    const { view, onEnded } = renderOpen(h);
    push('voice:session:ended', {
      voiceSessionId: 'vs-orphan',
      reason: 'taken-over',
      message: 'x',
    });
    expect(view.result.current.phase).toBe('off');
    expect(toastHolder.showToast).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('keeps a warmup failure visible after the mic starts', async () => {
    const h = makeHarness();
    const { view } = renderOpen(h);
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1', requestId: lastStartRequestId() });
    push('voice:error', { message: 'voice engine failed to initialize: x', speakable: false });
    await h.fireMicReady();
    expect(view.result.current.lastError).toBe('voice engine failed to initialize: x');
  });

  it('a deliberate stop clears the previous failure', async () => {
    const h = makeHarness();
    const { view } = renderOpen(h);
    act(() => view.result.current.start());
    push('voice:session:started', { voiceSessionId: 'vs1', requestId: lastStartRequestId() });
    push('voice:error', { message: 'STT crashed', speakable: false });
    expect(view.result.current.lastError).toBe('STT crashed');
    act(() => view.result.current.stop());
    expect(view.result.current.lastError).toBeNull();
  });
});
