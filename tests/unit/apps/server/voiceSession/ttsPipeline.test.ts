/**
 * ttsPipeline — streaming TTS.
 *
 * Proves the delta tap speaks on the first completed sentence (before the
 * utterance persists), the persist tap closes + reconciles the streaming job
 * (flush remainder → tts:end, synthetic id → real messageId), dedup (a persist
 * after streaming never double-synthesizes), the catch-up guard (a persist with
 * no prior stream synthesizes the whole utterance), strict per-utterance ordering
 * under slow synth, and text-thread zero-touch (no sink → no synthesis).
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: { warn: jest.fn(), error: jest.fn(), socket: { event: jest.fn() } },
}));

const agentGet = jest.fn().mockResolvedValue({ id: 'A', name: 'Nova', voice: null });
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: (...a: unknown[]) => agentGet(...a) },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { listRecentByThreadId: jest.fn().mockResolvedValue([]) },
}));

import {
  initTtsPipeline,
  registerTtsSink,
  __setSegmenter,
  __setStreamSegmenterFactory,
  __resetTtsPipeline,
  type TtsSink,
} from '@server/services/SocketService/voiceSession/ttsPipeline';
import { openFloor, __resetFloors } from '@server/services/SocketService/voiceSession/floorArbiter';
import {
  emitVoiceDelta,
  __resetVoiceDeltaListeners,
} from '@server/services/SocketService/voiceSession/voiceStreamEvents';
import {
  emitUtterancePersisted,
  __resetUtteranceListeners,
} from '@server/services/SocketService/voiceSession/utteranceEvents';
import {
  __setVoiceEngineForTest,
  __resetVoiceEngine,
} from '@server/services/SocketService/voiceSession/engineAdapter';
import {
  getSpokenText,
  getSynthesizedMs,
  getReconciledMessageId,
  __resetDurations,
} from '@server/services/SocketService/voiceSession/ttsDurationTracker';
import type { StreamSegmenter } from '@server/services/SocketService/voiceSession/speakability';
import type {
  VoiceEngineApi,
  VoiceTtsChunkPayload,
  VoiceTtsEndPayload,
} from '@server/services/SocketService/voiceSession/types';

const THREAD = 'thread-1';
const AGENT = 'A';

const settle = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Deterministic streaming segmenter: sentences end at '.'; flush drains the tail. */
function fakeStreamSegmenter(): StreamSegmenter {
  let buf = '';
  const drain = (): string[] => {
    const out: string[] = [];
    let idx: number;
    while ((idx = buf.indexOf('.')) >= 0) {
      const s = buf.slice(0, idx + 1).trim();
      if (s) out.push(s);
      buf = buf.slice(idx + 1);
    }
    return out;
  };
  return {
    push: (delta) => {
      buf += delta;
      return drain();
    },
    flush: () => {
      const s = buf.trim();
      buf = '';
      return s ? [s] : [];
    },
    reset: () => {
      buf = '';
    },
  };
}

/** Fake engine: one frame per synthesized sentence; records call order; optional
 *  gate on the first synthesize call to prove serialization under slow synth. */
function makeEngine(opts: { gateFirst?: boolean } = {}): {
  engine: VoiceEngineApi;
  calls: string[];
  releaseFirst: () => void;
} {
  const calls: string[] = [];
  let releaseFirst = (): void => {};
  const firstGate = new Promise<void>((r) => {
    releaseFirst = r;
  });
  let callIdx = 0;
  const engine = {
    createSttSession: () => {
      throw new Error('no STT in this test');
    },
    synthesize(text: string): AsyncIterable<{ pcm16: Int16Array; sampleRate: number }> {
      const idx = callIdx++;
      return (async function* () {
        calls.push(text);
        if (opts.gateFirst && idx === 0) await firstGate;
        yield { pcm16: Int16Array.from([100, -200, 300, -400]), sampleRate: 16000 };
      })();
    },
  } as unknown as VoiceEngineApi;
  return { engine, calls, releaseFirst };
}

function makeSink(): {
  sink: TtsSink;
  chunks: VoiceTtsChunkPayload[];
  ends: VoiceTtsEndPayload[];
} {
  const chunks: VoiceTtsChunkPayload[] = [];
  const ends: VoiceTtsEndPayload[] = [];
  return {
    sink: { emitChunk: (p) => chunks.push(p), emitEnd: (p) => ends.push(p) },
    chunks,
    ends,
  };
}

function openThread(): { chunks: VoiceTtsChunkPayload[]; ends: VoiceTtsEndPayload[] } {
  const { sink, chunks, ends } = makeSink();
  openFloor(THREAD, { emitFloor: () => {} });
  registerTtsSink(THREAD, sink);
  return { chunks, ends };
}

beforeEach(() => {
  __resetTtsPipeline();
  __resetFloors();
  __resetDurations();
  __resetVoiceDeltaListeners();
  __resetUtteranceListeners();
  __resetVoiceEngine();
  __setStreamSegmenterFactory(fakeStreamSegmenter);
  __setSegmenter({ segment: (raw: string) => (raw ? [{ text: raw }] : []) });
  initTtsPipeline();
});

afterEach(() => {
  __resetTtsPipeline();
  __resetFloors();
  __resetDurations();
  __resetVoiceDeltaListeners();
  __resetUtteranceListeners();
  __resetVoiceEngine();
  agentGet.mockClear();
});

describe('streaming delta tap — speak on first sentence, before persist', () => {
  it('emits tts:chunk for the first sentence while the delta stream is still open', async () => {
    const { engine } = makeEngine();
    __setVoiceEngineForTest(engine);
    const { chunks, ends } = openThread();

    // First completed sentence arrives; the utterance has not persisted yet.
    emitVoiceDelta({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      iteration: 1,
      text: 'Hello there. ',
    });
    await settle();

    // Audio for the synthetic id streamed before any persist event.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.utteranceId).toBe('run1:1');
    expect(chunks[0]!.agentId).toBe(AGENT);
    expect(ends.length).toBe(0); // utterance still open — no tts:end yet
  });

  it('flushes the remainder + emits tts:end + reconciles on persist', async () => {
    const { engine, calls } = makeEngine();
    __setVoiceEngineForTest(engine);
    const { chunks, ends } = openThread();

    emitVoiceDelta({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      iteration: 1,
      text: 'First one. ',
    });
    await settle();
    emitVoiceDelta({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      iteration: 1,
      text: 'trailing partial',
    });
    await settle();
    expect(ends.length).toBe(0);

    // Persist closes the job: flush "trailing partial", synth it, then tts:end.
    emitUtterancePersisted({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      messageId: 'msg-1',
      content: 'First one. trailing partial',
      hasUsage: true,
      logLabel: 'assistant message',
    });
    await settle();

    expect(calls).toEqual(['First one.', 'trailing partial']);
    expect(ends).toEqual([{ utteranceId: 'run1:1' }]);
    // All chunks keyed by the synthetic id (client never sees the real messageId).
    expect(new Set(chunks.map((c) => c.utteranceId))).toEqual(new Set(['run1:1']));
    // Reconcile: synthetic → real messageId; tracker resolves via either id.
    expect(getReconciledMessageId('run1:1')).toBe('msg-1');
    expect(getSpokenText('run1:1')).toBe('First one. trailing partial');
    expect(getSynthesizedMs('msg-1')).toBeGreaterThan(0); // resolved via alias
  });

  it('a persist for a streamed run does not re-synthesize (dedup)', async () => {
    const { engine, calls } = makeEngine();
    __setVoiceEngineForTest(engine);
    const oneShot = jest.fn((raw: string) => (raw ? [{ text: raw }] : []));
    __setSegmenter({ segment: oneShot });
    openThread();

    emitVoiceDelta({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      iteration: 1,
      text: 'Only sentence. ',
    });
    await settle();
    expect(calls).toEqual(['Only sentence.']);

    emitUtterancePersisted({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      messageId: 'msg-1',
      content: 'Only sentence.',
      hasUsage: true,
      logLabel: 'assistant message',
    });
    await settle();

    // No new synth from the persist path; the whole-utterance segmenter untouched.
    expect(calls).toEqual(['Only sentence.']);
    expect(oneShot).not.toHaveBeenCalled();
  });
});

describe('catch-up guard — persist with no prior stream synthesizes whole utterance', () => {
  it('synthesizes the whole utterance keyed by the real messageId', async () => {
    const { engine, calls } = makeEngine();
    __setVoiceEngineForTest(engine);
    const { chunks, ends } = openThread();

    // No deltas ever streamed for run9 (voice toggled on mid-run).
    emitUtterancePersisted({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run9',
      messageId: 'msg-9',
      content: 'Caught up whole utterance.',
      hasUsage: true,
      logLabel: 'assistant message',
    });
    await settle();

    expect(calls).toEqual(['Caught up whole utterance.']);
    expect(chunks.every((c) => c.utteranceId === 'msg-9')).toBe(true);
    expect(ends).toEqual([{ utteranceId: 'msg-9' }]);
  });

  it('never synthesizes a cut-off partial-abort that never streamed', async () => {
    const { engine, calls } = makeEngine();
    __setVoiceEngineForTest(engine);
    openThread();

    emitUtterancePersisted({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run9',
      messageId: 'msg-9',
      content: 'Half a sen',
      hasUsage: false,
      logLabel: 'partial utterance persisted (aborted mid-utterance)',
    });
    await settle();
    expect(calls).toEqual([]);
  });
});

describe('abort-partial close — remainder discarded, reconcile still happens', () => {
  it('does not speak the flushed remainder after a mid-stream abort', async () => {
    const { engine, calls } = makeEngine();
    __setVoiceEngineForTest(engine);
    openThread();

    emitVoiceDelta({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      iteration: 1,
      text: 'Spoken bit. ',
    });
    await settle();
    emitVoiceDelta({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      iteration: 1,
      text: 'not yet spoken',
    });
    await settle();
    expect(calls).toEqual(['Spoken bit.']);

    // Abort-partial persist: close without flushing the remainder.
    emitUtterancePersisted({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      messageId: 'msg-1',
      content: 'Spoken bit. not yet spoken',
      hasUsage: false,
      logLabel: 'partial utterance persisted (aborted mid-utterance)',
    });
    await settle();

    expect(calls).toEqual(['Spoken bit.']); // remainder discarded
    expect(getReconciledMessageId('run1:1')).toBe('msg-1'); // still reconciled
  });
});

describe('ordering — sentences synthesize strictly in order under slow synth', () => {
  it('serializes per job even when later sentences arrive during a slow synth', async () => {
    const { engine, calls, releaseFirst } = makeEngine({ gateFirst: true });
    __setVoiceEngineForTest(engine);
    const { chunks } = openThread();

    // First sentence starts synth and blocks on the gate.
    emitVoiceDelta({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      iteration: 1,
      text: 'one. ',
    });
    await settle();
    expect(calls).toEqual(['one.']); // started, gated (no yield yet)
    expect(chunks.length).toBe(0);

    // Two more sentences arrive while the first is still synthesizing.
    emitVoiceDelta({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      iteration: 1,
      text: 'two. three. ',
    });
    await settle();
    expect(calls).toEqual(['one.']); // still gated — not started out of order

    releaseFirst();
    await settle();

    expect(calls).toEqual(['one.', 'two.', 'three.']);
    // Chunk seq is monotonic within the one synthetic utterance.
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(new Set(chunks.map((c) => c.utteranceId))).toEqual(new Set(['run1:1']));
  });
});

describe('text-thread zero-touch — no sink means no synthesis', () => {
  it('a delta on a thread with no registered sink synthesizes nothing', async () => {
    const { engine, calls } = makeEngine();
    __setVoiceEngineForTest(engine);
    // Note: no openThread() — no sink registered for THREAD.
    openFloor(THREAD, { emitFloor: () => {} }); // floor exists, but no tts sink

    emitVoiceDelta({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      iteration: 1,
      text: 'Ignored. ',
    });
    emitUtterancePersisted({
      threadId: THREAD,
      agentId: AGENT,
      runId: 'run1',
      messageId: 'msg-1',
      content: 'Ignored.',
      hasUsage: true,
      logLabel: 'assistant message',
    });
    await settle();
    expect(calls).toEqual([]);
  });
});
