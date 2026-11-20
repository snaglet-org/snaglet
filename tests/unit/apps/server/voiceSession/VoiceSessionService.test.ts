/**
 * VoiceSessionService — session lifecycle, dispatch-mode support, pill/default
 * targeting, barge-in routing (inject vs abort + heard-up-to), cancelDispatch,
 * and voice-mode thread_event writes. The audio engine is a fake VoiceEngineApi;
 * the floor/pipeline/DB/socket seams are mocked.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Pin the endpoint windows for these routing/lifecycle tests so their fixed
// silence-frame counts stay deterministic regardless of the product defaults
// (1 s / 1.3 s in constants). The extended barge-in window's behavior
// is covered directly in openMicVad.test.ts (setSilenceForCurrentRun).
jest.mock('@server/services/SocketService/voiceSession/constants', () => ({
  ...jest.requireActual('@server/services/SocketService/voiceSession/constants'),
  OPEN_MIC_SILENCE_MS: 300,
  OPEN_MIC_BARGEIN_SILENCE_MS: 300,
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: {
    warn: jest.fn(),
    error: jest.fn(),
    socket: { event: jest.fn() },
    user: { message: jest.fn() },
  },
}));

const broadcastToChannel = jest.fn();
const sendToClient = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
    sendToClient: (...a: unknown[]) => sendToClient(...a),
    registerHandler: jest.fn(),
    onDisconnect: jest.fn(),
  },
}));

const threadsFindById = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...a: unknown[]) => threadsFindById(...a) },
}));

const participantsList = jest.fn();
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: (...a: unknown[]) => participantsList(...a) },
}));

const messagesFindById = jest.fn();
const listRecent = jest.fn();
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    findById: (...a: unknown[]) => messagesFindById(...a),
    listRecentByThreadId: (...a: unknown[]) => listRecent(...a),
  },
}));

const setSession = jest.fn<Promise<void>, unknown[]>(async () => {});
jest.mock('@server/services/SocketService/store', () => ({
  setSession: (...a: unknown[]) => setSession(...a),
}));

const agentGet = jest.fn();
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: (...a: unknown[]) => agentGet(...a) },
}));

const processChatSend = jest.fn<Promise<void>, unknown[]>(async () => {});
jest.mock('@server/services/SocketService/handlers/chatHandlers', () => ({
  processChatSend: (...a: unknown[]) => processChatSend(...a),
}));

const emitEnabled = jest.fn<Promise<void>, unknown[]>(async () => {});
const emitDisabled = jest.fn<Promise<void>, unknown[]>(async () => {});
jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitVoiceModeEnabledEvent: (...a: unknown[]) => emitEnabled(...a),
  emitVoiceModeDisabledEvent: (...a: unknown[]) => emitDisabled(...a),
}));

const abortThread = jest.fn<number, unknown[]>(() => 1);
jest.mock('@server/services/SocketService/abortStore', () => ({
  abortThread: (...a: unknown[]) => abortThread(...a),
}));

const openFloor = jest.fn();
const closeFloor = jest.fn();
const notePlaybackDone = jest.fn();
const clearFloorForBargeIn = jest.fn();
const currentFloorHolder = jest.fn<string | null, [string]>(() => null);
const currentFloorUtteranceId = jest.fn<string | null, [string]>(() => null);
jest.mock('@server/services/SocketService/voiceSession/floorArbiter', () => ({
  openFloor: (...a: unknown[]) => openFloor(...a),
  closeFloor: (...a: unknown[]) => closeFloor(...a),
  notePlaybackDone: (...a: unknown[]) => notePlaybackDone(...a),
  clearFloorForBargeIn: (...a: unknown[]) => clearFloorForBargeIn(...a),
  currentFloorHolder: (...a: [string]) => currentFloorHolder(...a),
  currentFloorUtteranceId: (...a: [string]) => currentFloorUtteranceId(...a),
}));

const registerTtsSink = jest.fn();
const unregisterTtsSink = jest.fn();
jest.mock('@server/services/SocketService/voiceSession/ttsPipeline', () => ({
  registerTtsSink: (...a: unknown[]) => registerTtsSink(...a),
  unregisterTtsSink: (...a: unknown[]) => unregisterTtsSink(...a),
  initTtsPipeline: jest.fn(),
}));

const isToolInFlight = jest.fn<boolean, unknown[]>(() => false);
jest.mock('@server/services/SocketService/voiceSession/runPhaseTracker', () => ({
  isToolInFlight: (...a: unknown[]) => isToolInFlight(...a),
  clearRunPhase: jest.fn(),
  initRunPhaseTracker: jest.fn(),
}));

import { voiceSessionService } from '@server/services/SocketService/voiceSession/VoiceSessionService';
import { __setVoiceEngineForTest } from '@server/services/SocketService/voiceSession/engineAdapter';
import { LogsService } from '@server/services/LogsService';
import { OPEN_MIC_MAX_PENDING_FRAMES } from '@server/services/SocketService/voiceSession/constants';
import { isThreadVoiceActive } from '@server/services/SocketService/voiceSession/voiceSessionRegistry';
import type { VoiceEngineApi } from '@server/services/SocketService/voiceSession/types';

const THREAD = 'thread-1';
const CLIENT = 'client-1';
// Thread-level exclusivity (takeover) fixtures — a second window / second thread.
const THREAD_2 = 'thread-2';
const CLIENT_A = 'client-A';
const CLIENT_B = 'client-B';

let nextTranscript = 'hello there';
// The quality (Moonshine) tier the fake engine returns for the next utterance.
// null → return '' so the pipeline falls back to the normalized streaming final
// (keeps the streaming-only behavioral assertions intact); set it to override.
let nextQuality: (() => Promise<string>) | null = null;
// The most recent streaming-STT onPartial callback the service wired — the
// converging-preview tests fire it to exercise emitPartial (tier:'live').
let capturedOnPartial: ((text: string) => void) | null = null;
// Scripted VAD probability the fake engine returns for every frame of the next
// audio chunk fed; the open-mic tests set it before each feed.
let vadProb = 0.02;
const vadProcess = jest.fn(async () => vadProb);
const vadClose = jest.fn(async () => {});
const warmup = jest.fn(async () => {});
const shutdown = jest.fn(async () => {});
const qualityDecode = jest.fn(async (_pcm: Int16Array) => (nextQuality ? nextQuality() : ''));
// Every pcm16 frame the local fake STT session is fed (asserts band-limiting).
let fedFrames: Int16Array[] = [];
const fakeEngine: VoiceEngineApi = {
  createSttSession: () => ({
    feed: (pcm16: Int16Array) => fedFrames.push(pcm16),
    onPartial: (cb: (text: string) => void) => {
      capturedOnPartial = cb;
    },
    finalize: jest.fn(async () => nextTranscript),
    close: jest.fn(),
  }),
  qualityDecode,
  synthesize: async function* () {
    /* no audio needed for these tests */
  },
  createVadSession: async () => ({ process: vadProcess, close: vadClose }),
  warmup,
  shutdown,
};

const tick = () => new Promise((r) => setImmediate(r));
/** Drain the open-mic async processing chain (each VAD frame awaits). */
async function settle(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
const audioB64 = Buffer.from([1, 0, 2, 0]).toString('base64');
/** base64 pcm16 chunk of `frames` × 512 samples (drives `frames` VAD frames). */
function openMicChunk(frames: number): string {
  return Buffer.alloc(frames * 512 * 2).toString('base64');
}
interface VoiceFramePayload {
  voiceSessionId?: string;
  messageId?: string;
  text?: string;
  [key: string]: unknown;
}

interface VoiceFrame {
  type: string;
  payload: VoiceFramePayload;
}

/** base64 pcm16 chunk of exactly `samples` 16-bit samples. */
function pcmChunk(samples: number): string {
  return Buffer.alloc(samples * 2).toString('base64');
}

function frameOfType(type: string): VoiceFrame | undefined {
  const calls = broadcastToChannel.mock.calls as unknown as Array<[string, VoiceFrame]>;
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i]![1].type === type) return calls[i]![1];
  return undefined;
}

async function startSession(opts: {
  dispatchMode?: 'mentioned' | 'all' | (string & {});
  participants?: string[];
  targetAgentIds?: string[];
}): Promise<string | undefined> {
  threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: opts.dispatchMode ?? 'mentioned' });
  participantsList.mockResolvedValue(
    (opts.participants ?? ['agent-A']).map((agentId) => ({ agentId }))
  );
  await voiceSessionService.start(
    { threadId: THREAD, mode: 'ptt', targetAgentIds: opts.targetAgentIds },
    CLIENT
  );
  return frameOfType('voice:session:started')?.payload.voiceSessionId;
}

async function speak(
  voiceSessionId: string,
  transcript: string,
  extra: Record<string, unknown> = {}
) {
  nextTranscript = transcript;
  voiceSessionService.audioChunk({ voiceSessionId, seq: 0, pcm16: audioB64 }, CLIENT);
  await tick(); // let openStt resolve + wire the STT session
  await voiceSessionService.utteranceEnd({ voiceSessionId, ...extra } as never, CLIENT);
}

// thread-level exclusivity (takeover) helpers

/** Start a PTT session for an explicit (thread, client) and return its id. */
async function startFor(
  threadId: string,
  clientId: string,
  opts: { targetAgentIds?: string[]; participants?: string[] } = {}
): Promise<string> {
  threadsFindById.mockResolvedValue({ id: threadId, dispatchMode: 'mentioned' });
  participantsList.mockResolvedValue(
    (opts.participants ?? ['agent-A']).map((agentId) => ({ agentId }))
  );
  await voiceSessionService.start(
    { threadId, mode: 'ptt', targetAgentIds: opts.targetAgentIds },
    clientId
  );
  await tick();
  return startedIdFor(threadId)!;
}

/** The voiceSessionId from the most recent voice:session:started on `threadId`. */
function startedIdFor(threadId: string): string | undefined {
  const calls = broadcastToChannel.mock.calls as unknown as Array<[string, VoiceFrame]>;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]![0] === threadId && calls[i]![1].type === 'voice:session:started') {
      return calls[i]![1].payload.voiceSessionId as string;
    }
  }
  return undefined;
}

/** The most recent voice:session:ended frame sent directly to `clientId`, if any. */
function endedFrameTo(clientId: string): VoiceFrame | undefined {
  const calls = sendToClient.mock.calls as unknown as Array<[string, VoiceFrame]>;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]![0] === clientId && calls[i]![1].type === 'voice:session:ended')
      return calls[i]![1];
  }
  return undefined;
}

/** Drive one utterance for an explicit (session, client). */
async function speakAs(
  voiceSessionId: string,
  clientId: string,
  transcript: string
): Promise<void> {
  nextTranscript = transcript;
  voiceSessionService.audioChunk({ voiceSessionId, seq: 0, pcm16: audioB64 }, clientId);
  await tick();
  await voiceSessionService.utteranceEnd({ voiceSessionId } as never, clientId);
}

beforeEach(() => {
  jest.clearAllMocks();
  fedFrames = [];
  __setVoiceEngineForTest(fakeEngine);
  agentGet.mockImplementation(async (id: string) => ({
    id,
    name: id === 'agent-A' ? 'Nova' : id === 'agent-B' ? 'Vega' : id,
  }));
  isToolInFlight.mockReturnValue(false);
  clearFloorForBargeIn.mockReturnValue(null);
  currentFloorHolder.mockReturnValue(null);
  currentFloorUtteranceId.mockReturnValue(null);
  vadProb = 0.02;
  nextQuality = null;
  capturedOnPartial = null;
  delete process.env.SNAGLET_VOICE_PREVIEW_DECODE_MS;
});

/** Start an open-mic session and return its voiceSessionId. */
async function startOpenSession(
  opts: {
    participants?: string[];
    targetAgentIds?: string[];
    dictate?: boolean;
    speak?: boolean;
  } = {}
): Promise<string> {
  threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
  participantsList.mockResolvedValue(
    (opts.participants ?? ['agent-A']).map((agentId) => ({ agentId }))
  );
  await voiceSessionService.start(
    {
      threadId: THREAD,
      mode: 'open',
      targetAgentIds: opts.targetAgentIds,
      dictate: opts.dictate,
      speak: opts.speak,
    },
    CLIENT
  );
  await settle(); // initOpenMic awaits engine.createVadSession
  return frameOfType('voice:session:started')!.payload.voiceSessionId as string;
}

describe('open-mic dictate/speak split', () => {
  it('dictate-only finalizes into an editable draft and never auto-sends', async () => {
    const vsid = await startOpenSession({
      participants: ['agent-A'],
      targetAgentIds: ['agent-A'],
      dictate: true,
      speak: false,
    });

    nextTranscript = 'buy milk tomorrow';
    await feedOpen(vsid, 0.9, 20);
    await feedOpen(vsid, 0.02, 12);

    expect(processChatSend).not.toHaveBeenCalled();
    expect(frameOfType('voice:final')?.payload).toEqual({
      text: 'buy milk tomorrow',
      messageId: null,
      utteranceSeq: 1,
    });
    expect(registerTtsSink).not.toHaveBeenCalled();
  });

  it('full Voice mode auto-sends and keeps the agent-reply TTS sink active', async () => {
    const vsid = await startOpenSession({
      participants: ['agent-A'],
      targetAgentIds: ['agent-A'],
      dictate: true,
      speak: true,
    });

    nextTranscript = 'what is next';
    await feedOpen(vsid, 0.9, 20);
    await feedOpen(vsid, 0.02, 12);

    expect(processChatSend).toHaveBeenCalledTimes(1);
    expect(registerTtsSink).toHaveBeenCalledWith(THREAD, expect.any(Object));
  });
});

/** Feed `frames` open-mic frames at probability `prob`, then let VAD settle. */
async function feedOpen(vsid: string, prob: number, frames: number): Promise<void> {
  vadProb = prob;
  voiceSessionService.audioChunk(
    { voiceSessionId: vsid, seq: 0, pcm16: openMicChunk(frames) },
    CLIENT
  );
  await settle();
}

afterEach(() => voiceSessionService.__reset());

describe('lifecycle', () => {
  it('starts a solo session: creates a chat session, opens floor/sink, writes the enabled event', async () => {
    const vsid = await startSession({ participants: ['agent-A'] });
    expect(vsid).toBeTruthy();
    expect(setSession).toHaveBeenCalledTimes(1);
    expect(openFloor).toHaveBeenCalledWith(THREAD, expect.any(Object));
    expect(registerTtsSink).toHaveBeenCalledWith(THREAD, expect.any(Object));
    expect(emitEnabled).toHaveBeenCalledWith(THREAD);
    // session:started rides the thread channel (channel === threadId).
    expect(broadcastToChannel).toHaveBeenCalledWith(
      THREAD,
      expect.objectContaining({ type: 'voice:session:started' })
    );
  });

  it('rejects the engine-unavailable case with a non-speakable error', async () => {
    __setVoiceEngineForTest(null);
    await startSession({ participants: ['agent-A'] });
    expect(frameOfType('voice:error')?.payload).toEqual({
      message: "Voice isn't available: Snaglet's voice engine couldn't load.",
      speakable: false,
    });
    expect(setSession).not.toHaveBeenCalled();
  });

  it.each(['all', 'mentioned'] as const)(
    "starts a group session in '%s' mode on the shared single-speaker floor",
    async (dispatchMode) => {
      const vsid = await startSession({
        dispatchMode,
        participants: ['agent-A', 'agent-B'],
        targetAgentIds: ['agent-A'],
      });

      expect(vsid).toBeTruthy();
      expect(setSession).toHaveBeenCalledTimes(1);
      expect(openFloor).toHaveBeenCalledWith(THREAD, expect.any(Object));
      expect(registerTtsSink).toHaveBeenCalledWith(THREAD, expect.any(Object));
      expect(frameOfType('voice:error')).toBeUndefined();
    }
  );

  it('fails closed for an unknown routing mode', async () => {
    // Unknown modes fail closed regardless of participant count, solo threads
    // included.
    await startSession({ dispatchMode: 'future-fanout', participants: ['agent-A'] });

    expect(frameOfType('voice:error')?.payload).toEqual({
      message: "Voice mode does not support routing mode 'future-fanout'.",
      speakable: false,
    });
    expect(setSession).not.toHaveBeenCalled();
    expect(openFloor).not.toHaveBeenCalled();
    expect(registerTtsSink).not.toHaveBeenCalled();
  });

  it('echoes the client requestId on voice:session:started', async () => {
    threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue([{ agentId: 'agent-A' }]);
    await voiceSessionService.start({ threadId: THREAD, mode: 'ptt', requestId: 'req-1' }, CLIENT);
    expect(frameOfType('voice:session:started')?.payload).toEqual({
      voiceSessionId: expect.any(String),
      requestId: 'req-1',
    });
  });

  it('tags a handshake failure with the requestId so the client can end that handshake', async () => {
    __setVoiceEngineForTest(null);
    await voiceSessionService.start({ threadId: THREAD, mode: 'open', requestId: 'req-1' }, CLIENT);
    expect(frameOfType('voice:error')?.payload).toEqual({
      message: "Voice isn't available: Snaglet's voice engine couldn't load.",
      speakable: false,
      requestId: 'req-1',
    });
  });

  it('reports an unexpected start failure instead of leaving the client to time out', async () => {
    threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue([{ agentId: 'agent-A' }]);
    setSession.mockRejectedValueOnce(new Error('session store offline'));
    await voiceSessionService.start({ threadId: THREAD, mode: 'open', requestId: 'req-1' }, CLIENT);
    expect(frameOfType('voice:error')?.payload).toEqual({
      message: "Voice couldn't start: session store offline",
      speakable: false,
      requestId: 'req-1',
    });
    expect(frameOfType('voice:session:started')).toBeUndefined();
  });

  it('only the latest of two overlapping starts from one client opens a session', async () => {
    threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue([{ agentId: 'agent-A' }]);
    const first = voiceSessionService.start(
      { threadId: THREAD, mode: 'open', dictate: true, speak: false, requestId: 'req-1' },
      CLIENT
    );
    const second = voiceSessionService.start(
      { threadId: THREAD, mode: 'open', dictate: true, speak: false, requestId: 'req-2' },
      CLIENT
    );
    await Promise.all([first, second]);
    await settle();

    const started = (broadcastToChannel.mock.calls as unknown as Array<[string, VoiceFrame]>)
      .map(([, frame]) => frame)
      .filter((frame) => frame.type === 'voice:session:started');
    expect(started).toHaveLength(1);
    expect(started[0]!.payload.requestId).toBe('req-2');
    expect(setSession).toHaveBeenCalledTimes(1);
  });

  it('a disconnect during the handshake leaves no session behind', async () => {
    threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue([{ agentId: 'agent-A' }]);
    const pending = voiceSessionService.start({ threadId: THREAD, mode: 'open' }, CLIENT);
    voiceSessionService.handleDisconnect(CLIENT);
    await pending;
    await settle();
    expect(frameOfType('voice:session:started')).toBeUndefined();
    expect(setSession).not.toHaveBeenCalled();
  });

  it('writes the disabled event on stop and on disconnect', async () => {
    const vsid = await startSession({ participants: ['agent-A'] });
    voiceSessionService.stop({ voiceSessionId: vsid }, CLIENT);
    expect(emitDisabled).toHaveBeenCalledWith(THREAD);
    expect(closeFloor).toHaveBeenCalledWith(THREAD);
    expect(unregisterTtsSink).toHaveBeenCalledWith(THREAD);

    emitDisabled.mockClear();
    const vsid2 = await startSession({ participants: ['agent-A'] });
    voiceSessionService.handleDisconnect(CLIENT);
    expect(emitDisabled).toHaveBeenCalledWith(THREAD);
    void vsid2;
  });
});

describe('capture-rate band-limiting (native → 16k)', () => {
  it('band-limits a native-rate (48 kHz) chunk to 16 kHz before feeding the local engine', async () => {
    const sid = (await startSession({ participants: ['agent-A'] }))!;
    // First chunk opens the STT session (retained, not streamed); the second is
    // the one fed to the recognizer.
    voiceSessionService.audioChunk(
      { voiceSessionId: sid, seq: 0, pcm16: pcmChunk(4800), sampleRate: 48_000 } as never,
      CLIENT
    );
    await tick();
    voiceSessionService.audioChunk(
      { voiceSessionId: sid, seq: 1, pcm16: pcmChunk(4800), sampleRate: 48_000 } as never,
      CLIENT
    );
    await tick();
    expect(fedFrames.length).toBeGreaterThanOrEqual(1);
    // 4800 samples @48k → ~1600 @16k (one third), not the native 4800.
    const fed = fedFrames[fedFrames.length - 1]!;
    expect(Math.abs(fed.length - 1600)).toBeLessThan(20);
  });

  it('leaves a 16 kHz chunk untouched (identity pass-through)', async () => {
    const sid = (await startSession({ participants: ['agent-A'] }))!;
    voiceSessionService.audioChunk({ voiceSessionId: sid, seq: 0, pcm16: pcmChunk(1600) }, CLIENT);
    await tick();
    voiceSessionService.audioChunk({ voiceSessionId: sid, seq: 1, pcm16: pcmChunk(1600) }, CLIENT);
    await tick();
    expect(fedFrames[fedFrames.length - 1]!.length).toBe(1600);
  });
});

describe('thread-level exclusivity (takeover)', () => {
  it('a second window on the same thread takes over: old torn down + notified, new functional', async () => {
    const vsA = await startFor(THREAD, CLIENT_A, { targetAgentIds: ['agent-A'] });
    const vsB = await startFor(THREAD, CLIENT_B, { targetAgentIds: ['agent-A'] });
    expect(vsB).toBeTruthy();
    expect(vsB).not.toBe(vsA);

    // The displaced client A is notified directly (sendToClient), never broadcast —
    // a thread broadcast would also hit the taking-over client B.
    expect(endedFrameTo(CLIENT_A)?.payload).toEqual({
      voiceSessionId: vsA,
      reason: 'taken-over',
      message: 'voice session taken over by another window',
    });
    expect(frameOfType('voice:session:ended')).toBeUndefined(); // not on the thread channel
    // Thread stays voice-on across the handoff → no voice-disabled thread_event.
    expect(emitDisabled).not.toHaveBeenCalled();

    // A's session is fully torn down: its audio/utterance does not dispatch.
    processChatSend.mockClear();
    await speakAs(vsA, CLIENT_A, 'ghost of the old tab');
    expect(processChatSend).not.toHaveBeenCalled();

    // B's session is fully functional.
    await speakAs(vsB, CLIENT_B, 'the new tab speaks');
    expect(processChatSend).toHaveBeenCalledTimes(1);
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toBe('the new tab speaks @Nova');
  });

  it('same-client re-start on the same thread replaces its own session (no self-notify)', async () => {
    const vs1 = await startFor(THREAD, CLIENT_A, { targetAgentIds: ['agent-A'] });
    const vs2 = await startFor(THREAD, CLIENT_A, { targetAgentIds: ['agent-A'] });
    expect(vs2).toBeTruthy();
    expect(vs2).not.toBe(vs1);
    // Takeover only fires for a different client — never notify yourself.
    expect(endedFrameTo(CLIENT_A)).toBeUndefined();
    // The replaced-own session dispatches under the new id.
    await speakAs(vs2, CLIENT_A, 'still my mic');
    expect(processChatSend).toHaveBeenCalledTimes(1);
  });

  it('sessions on different threads coexist (no cross-thread takeover)', async () => {
    const vsA = await startFor(THREAD, CLIENT_A, { targetAgentIds: ['agent-A'] });
    const vsB = await startFor(THREAD_2, CLIENT_B, { targetAgentIds: ['agent-A'] });
    expect(endedFrameTo(CLIENT_A)).toBeUndefined();
    expect(endedFrameTo(CLIENT_B)).toBeUndefined();
    // Both dispatch independently on their own threads.
    await speakAs(vsA, CLIENT_A, 'thread one');
    await speakAs(vsB, CLIENT_B, 'thread two');
    expect(processChatSend).toHaveBeenCalledTimes(2);
  });
});

describe('dictate/speak split', () => {
  /** Start a PTT session with explicit dictate/speak flags. */
  async function startFlagged(
    clientId: string,
    flags: { dictate: boolean; speak: boolean },
    opts: { threadId?: string; targetAgentIds?: string[]; participants?: string[] } = {}
  ): Promise<string> {
    const threadId = opts.threadId ?? THREAD;
    threadsFindById.mockResolvedValue({ id: threadId, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue(
      (opts.participants ?? ['agent-A']).map((agentId) => ({ agentId }))
    );
    await voiceSessionService.start(
      { threadId, mode: 'ptt', targetAgentIds: opts.targetAgentIds, ...flags },
      clientId
    );
    await tick();
    return startedIdFor(threadId)!;
  }

  describe('speak-only (dictate:false, speak:true)', () => {
    it('registers the TTS sink + opens the floor, but never opens mic/STT', async () => {
      const vsid = await startFlagged(CLIENT, { dictate: false, speak: true });
      expect(vsid).toBeTruthy();
      expect(registerTtsSink).toHaveBeenCalledWith(THREAD, expect.any(Object));
      expect(openFloor).toHaveBeenCalledWith(THREAD, expect.any(Object));
      expect(emitEnabled).toHaveBeenCalledWith(THREAD);
      expect(isThreadVoiceActive(THREAD)).toBe(true); // VOICE_PROFILE_BLOCK gate

      // A stray audio chunk (defensive: the client shows no mic UI for a
      // speak-only session, so this should never happen in practice) must
      // never open an STT session — dictate is off.
      fedFrames = [];
      voiceSessionService.audioChunk({ voiceSessionId: vsid, seq: 0, pcm16: audioB64 }, CLIENT);
      await tick();
      expect(fedFrames).toHaveLength(0);

      // Likewise utteranceEnd is a no-op: no dispatch, no voice:final.
      processChatSend.mockClear();
      await voiceSessionService.utteranceEnd({ voiceSessionId: vsid }, CLIENT);
      expect(processChatSend).not.toHaveBeenCalled();
      expect(frameOfType('voice:final')).toBeUndefined();
    });

    it('is exempt from the mic-takeover lock: two speak-only sessions on one thread both stay active', async () => {
      const vsA = await startFlagged(
        CLIENT_A,
        { dictate: false, speak: true },
        {
          targetAgentIds: ['agent-A'],
        }
      );
      const vsB = await startFlagged(
        CLIENT_B,
        { dictate: false, speak: true },
        {
          targetAgentIds: ['agent-A'],
        }
      );
      expect(vsA).toBeTruthy();
      expect(vsB).toBeTruthy();
      // Neither displaced the other — no takeover notice to either client.
      expect(endedFrameTo(CLIENT_A)).toBeUndefined();
      expect(endedFrameTo(CLIENT_B)).toBeUndefined();
      // Both still hold a live, functional TTS sink registration.
      expect(registerTtsSink).toHaveBeenCalledWith(THREAD, expect.any(Object));
      expect(registerTtsSink).toHaveBeenCalledTimes(2);
    });

    it('a dictate session still locks: it takes over another dictate session even while speak-only sessions coexist', async () => {
      const speakOnly = await startFlagged(CLIENT_A, { dictate: false, speak: true });
      const dictateA = await startFlagged(CLIENT_B, { dictate: true, speak: false });
      const dictateB = await startFlagged('client-C', { dictate: true, speak: false });

      // The speak-only session was never touched by either dictate takeover.
      expect(endedFrameTo(CLIENT_A)).toBeUndefined();
      // dictateB took over dictateA's mic (both wanted the mic on the same thread).
      expect(endedFrameTo(CLIENT_B)?.payload).toEqual({
        voiceSessionId: dictateA,
        reason: 'taken-over',
        message: 'voice session taken over by another window',
      });
      void speakOnly;
      void dictateB;
    });
  });

  describe('dictate-only (dictate:true, speak:false)', () => {
    it('opens mic/STT, registers no TTS sink, writes no voice-mode-enabled event, and stays out of VOICE_PROFILE_BLOCK', async () => {
      const vsid = await startFlagged(CLIENT, { dictate: true, speak: false });
      expect(vsid).toBeTruthy();
      expect(registerTtsSink).not.toHaveBeenCalled();
      expect(openFloor).not.toHaveBeenCalled();
      expect(emitEnabled).not.toHaveBeenCalled();
      expect(isThreadVoiceActive(THREAD)).toBe(false); // no VOICE_PROFILE_BLOCK

      // Mic/STT does open: the first chunk opens the (lazily-created) STT
      // session, the second is fed to the recognizer (mirrors the
      // capture-rate band-limiting tests above).
      voiceSessionService.audioChunk(
        { voiceSessionId: vsid, seq: 0, pcm16: pcmChunk(1600) },
        CLIENT
      );
      await tick();
      voiceSessionService.audioChunk(
        { voiceSessionId: vsid, seq: 1, pcm16: pcmChunk(1600) },
        CLIENT
      );
      await tick();
      expect(fedFrames.length).toBeGreaterThan(0);
    });

    it('a finalized transcript is never auto-sent — it echoes via voice:final but skips processChatSend', async () => {
      const vsid = await startFlagged(
        CLIENT,
        { dictate: true, speak: false },
        {
          targetAgentIds: ['agent-A'],
        }
      );
      await speak(vsid, 'buy milk tomorrow');
      expect(processChatSend).not.toHaveBeenCalled();
      expect(frameOfType('voice:final')?.payload).toEqual({
        text: 'buy milk tomorrow',
        messageId: null,
        utteranceSeq: 1,
      });
    });

    it('writes no voice-mode-disabled event on stop (never wrote enabled either)', async () => {
      const vsid = await startFlagged(CLIENT, { dictate: true, speak: false });
      emitDisabled.mockClear();
      voiceSessionService.stop({ voiceSessionId: vsid }, CLIENT);
      expect(emitDisabled).not.toHaveBeenCalled();
    });
  });

  describe('both on (dictate:true, speak:true)', () => {
    it("matches today's exact combined behavior: mic opens, TTS sink registers, and a final auto-dispatches", async () => {
      const vsid = await startFlagged(
        CLIENT,
        { dictate: true, speak: true },
        {
          targetAgentIds: ['agent-A'],
        }
      );
      expect(registerTtsSink).toHaveBeenCalledWith(THREAD, expect.any(Object));
      expect(openFloor).toHaveBeenCalledWith(THREAD, expect.any(Object));
      expect(emitEnabled).toHaveBeenCalledWith(THREAD);
      expect(isThreadVoiceActive(THREAD)).toBe(true);

      await speak(vsid, 'ship the release');
      expect(processChatSend).toHaveBeenCalledTimes(1);
      const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
      expect(payload.message).toBe('ship the release @Nova');
    });
  });
});

describe('targeting → send', () => {
  it('appends @Name for each selected pill before sending, stamped voiceOriginated', async () => {
    const vsid = await startSession({
      participants: ['agent-A', 'agent-B'],
      targetAgentIds: ['agent-A', 'agent-B'],
    });
    await speak(vsid!, 'ship the release');
    expect(processChatSend).toHaveBeenCalledTimes(1);
    const [payload] = processChatSend.mock.calls[0] as unknown as [
      { message: string; voiceOriginated: boolean; sessionId: string },
    ];
    expect(payload.message).toBe('ship the release @Nova @Vega');
    expect(payload.voiceOriginated).toBe(true);
  });

  it('defaults to the last agent who spoke when no pills are selected', async () => {
    listRecent.mockResolvedValue([
      { role: 'user', content: 'hi' },
      { role: 'assistant', agentId: 'agent-B', content: 'earlier' },
    ]);
    const vsid = await startSession({ participants: ['agent-A', 'agent-B'] });
    await speak(vsid!, 'what is the status');
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toBe('what is the status @Vega');
  });

  it('live re-targeting via voice:targets:set changes the appended mentions', async () => {
    const vsid = await startSession({
      participants: ['agent-A', 'agent-B'],
      targetAgentIds: ['agent-A'],
    });
    voiceSessionService.setTargets({ voiceSessionId: vsid!, targetAgentIds: ['agent-B'] }, CLIENT);
    await speak(vsid!, 'over to you');
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toBe('over to you @Vega');
  });
});

describe('cancelDispatch (Esc bail-out)', () => {
  it('finalizes + echoes the transcript but does not dispatch', async () => {
    const vsid = await startSession({ participants: ['agent-A'] });
    await speak(vsid!, 'draft this message', { cancelDispatch: true });
    expect(processChatSend).not.toHaveBeenCalled();
    expect(frameOfType('voice:final')?.payload).toEqual({
      text: 'draft this message',
      messageId: null,
      utteranceSeq: 1,
    });
  });
});

describe('barge-in', () => {
  it('mid-tool → injects (no abort) and routes only to the interrupted agent + heard-up-to', async () => {
    clearFloorForBargeIn.mockReturnValue('agent-A');
    isToolInFlight.mockReturnValue(true);
    messagesFindById.mockResolvedValue({ content: 'Hello world here' });

    const vsid = await startSession({
      participants: ['agent-A', 'agent-B'],
      targetAgentIds: ['agent-B'],
    });
    voiceSessionService.bargeIn(
      { voiceSessionId: vsid!, heardUpTo: { utteranceId: 'u1', charOffset: 5 } },
      CLIENT
    );
    expect(abortThread).not.toHaveBeenCalled();

    await speak(vsid!, 'no wait stop');
    const [payload] = processChatSend.mock.calls[0] as unknown as [
      { message: string; persistedInjection?: string },
    ];
    // Only the interrupted agent (@Nova), not the standing pill (@Vega).
    expect(payload.message).toContain('no wait stop');
    expect(payload.message).toContain('@Nova');
    expect(payload.message).not.toContain('@Vega');
    // Content stays clean — the heard-up-to machinery is not in the message
    // (which becomes the user's chat bubble); it rides the persisted-injection
    // channel instead so the model still receives it adjacent to the message.
    expect(payload.message).not.toContain('[voice] user heard up to');
    expect(payload.persistedInjection).toBe('[voice] user heard up to: "Hello"');
  });

  it('content stays clean (raw transcript + routing mention only); marker rides persistedInjection', async () => {
    clearFloorForBargeIn.mockReturnValue('agent-A');
    isToolInFlight.mockReturnValue(true);
    messagesFindById.mockResolvedValue({ content: 'Hello world here' });

    const vsid = await startSession({ participants: ['agent-A'] });
    voiceSessionService.bargeIn(
      { voiceSessionId: vsid!, heardUpTo: { utteranceId: 'u1', charOffset: 5 } },
      CLIENT
    );

    await speak(vsid!, 'actually never mind');
    const [payload] = processChatSend.mock.calls[0] as unknown as [
      { message: string; persistedInjection?: string; voiceOriginated: boolean },
    ];
    // Bubble = the user's words + the interrupted agent's routing mention only.
    expect(payload.message).toBe('actually never mind @Nova');
    // The marker is delivered out-of-band, never in the persisted content.
    expect(payload.persistedInjection).toBe('[voice] user heard up to: "Hello"');
    expect(payload.voiceOriginated).toBe(true);
  });

  it('mid-speech → aborts the run first, then the utterance redispatches', async () => {
    clearFloorForBargeIn.mockReturnValue('agent-A');
    isToolInFlight.mockReturnValue(false);
    const vsid = await startSession({ participants: ['agent-A'] });
    voiceSessionService.bargeIn(
      { voiceSessionId: vsid!, heardUpTo: { utteranceId: 'u1', playedMs: 100 } },
      CLIENT
    );
    expect(abortThread).toHaveBeenCalledWith(THREAD);
  });

  it('is a no-op route when nothing was speaking (falls back to normal targeting)', async () => {
    clearFloorForBargeIn.mockReturnValue(null);
    const vsid = await startSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    voiceSessionService.bargeIn({ voiceSessionId: vsid! }, CLIENT);
    await speak(vsid!, 'normal message');
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toBe('normal message @Nova');
    expect(abortThread).not.toHaveBeenCalled();
  });
});

describe('playback:done', () => {
  it('forwards to the floor arbiter for the bound thread', async () => {
    const vsid = await startSession({ participants: ['agent-A'] });
    voiceSessionService.playbackDone({ voiceSessionId: vsid!, utteranceId: 'u9' }, CLIENT);
    expect(notePlaybackDone).toHaveBeenCalledWith(THREAD, 'u9');
  });
});

describe('warmup', () => {
  it('proactively warms the engine on session start', async () => {
    await startSession({ participants: ['agent-A'] });
    await tick();
    expect(warmup).toHaveBeenCalled();
  });

  it('warms everything for a push-to-talk session that dictates and speaks', async () => {
    await startSession({ participants: ['agent-A'] });
    await tick();
    expect(warmup).toHaveBeenCalledWith(undefined, { stt: true, tts: true, vad: false });
  });

  it('never warms a voice for a dictate-only session', async () => {
    await startOpenSession({ participants: ['agent-A'], dictate: true, speak: false });
    expect(warmup).toHaveBeenCalledWith(undefined, { stt: true, tts: false, vad: true });
  });

  it('surfaces a genuine engine-init failure as a non-speakable error', async () => {
    warmup.mockRejectedValueOnce(new Error('models missing'));
    await startSession({ participants: ['agent-A'] });
    await tick();
    await tick();
    expect(frameOfType('voice:error')?.payload).toEqual({
      message: expect.stringContaining('failed to initialize'),
      speakable: false,
    });
  });
});

describe('voice:final.messageId', () => {
  it('threads the persisted user-message id back into voice:final', async () => {
    processChatSend.mockImplementationOnce(async (_payload: unknown, meta: unknown) => {
      (meta as { onUserMessagePersisted?: (id: string) => void }).onUserMessagePersisted?.(
        'msg-42'
      );
    });
    const vsid = await startSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    await speak(vsid!, 'ship it');
    expect(frameOfType('voice:final')?.payload.messageId).toBe('msg-42');
  });
});

describe('voice:final emit timing', () => {
  it('emits voice:final at persist time — before processChatSend resolves', async () => {
    let resolveSend: (() => void) | undefined;
    // Persist fires early (the callback), then the run keeps going for a while
    // before processChatSend finally resolves.
    processChatSend.mockImplementationOnce(async (_payload: unknown, meta: unknown) => {
      (meta as { onUserMessagePersisted?: (id: string) => void }).onUserMessagePersisted?.(
        'msg-early'
      );
      await new Promise<void>((r) => (resolveSend = r));
    });

    const vsid = await startSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });

    // Kick off the utterance but do not await it — the send is still pending.
    const done = speak(vsid!, 'ship it');
    await settle();

    // voice:final already emitted (persist callback), carrying the id — even
    // though processChatSend has not resolved yet.
    expect(resolveSend).toBeDefined();
    expect(frameOfType('voice:final')?.payload).toEqual({
      text: 'ship it',
      messageId: 'msg-early',
      utteranceSeq: 1,
    });

    resolveSend?.();
    await done;

    // Exactly one voice:final — the resolve-time fallback is a no-op once emitted.
    const finals = (
      broadcastToChannel.mock.calls as unknown as Array<[string, { type: string }]>
    ).filter((c) => c[1].type === 'voice:final');
    expect(finals).toHaveLength(1);
  });

  it('still emits voice:final (null id) when persist never fires', async () => {
    processChatSend.mockImplementationOnce(async () => {
      // Resolve without ever calling onUserMessagePersisted.
    });
    const vsid = await startSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    await speak(vsid!, 'ship it');
    expect(frameOfType('voice:final')?.payload).toEqual({
      text: 'ship it',
      messageId: null,
      utteranceSeq: 1,
    });
  });
});

describe('two-tier STT', () => {
  it('dispatches the cased Moonshine tier over the all-caps streaming final', async () => {
    nextQuality = async () => 'Ship the release now.';
    const vsid = await startSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    await speak(vsid!, 'SHIP THE RELEASE NOW'); // zipformer: ALL CAPS
    expect(qualityDecode).toHaveBeenCalled();
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toBe('Ship the release now. @Nova');
    // voice:final carries the raw (quality) transcript — the mention is internal.
    expect(frameOfType('voice:final')?.payload.text).toBe('Ship the release now.');
  });

  it('normalizes the all-caps streaming final when the quality tier returns nothing', async () => {
    nextQuality = null; // → '' → fall back to the normalized streaming final
    const vsid = await startSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    await speak(vsid!, 'WHAT IS THE STATUS');
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toBe('What is the status @Nova');
  });

  it('degrades gracefully when the quality decode throws (dispatch never breaks)', async () => {
    nextQuality = async () => {
      throw new Error('moonshine unavailable');
    };
    const vsid = await startSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    await speak(vsid!, 'RESTART THE SERVER');
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toBe('Restart the server @Nova');
  });

  it('open-mic dispatches the quality tier off the VAD chain', async () => {
    nextQuality = async () => 'Deploy the new build.';
    const vsid = await startOpenSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    nextTranscript = 'DEPLOY THE NEW BUILD';
    await feedOpen(vsid, 0.9, 20); // speech
    await feedOpen(vsid, 0.02, 12); // silence → endpoint → dispatch
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toBe('Deploy the new build. @Nova');
  });
});

describe('converging preview cadence', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Start a PTT session under fake timers; returns its voiceSessionId. */
  async function startPtt(): Promise<string> {
    threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue([{ agentId: 'agent-A' }]);
    await voiceSessionService.start(
      { threadId: THREAD, mode: 'ptt', targetAgentIds: ['agent-A'] },
      CLIENT
    );
    return frameOfType('voice:session:started')!.payload.voiceSessionId as string;
  }

  it('re-decodes the accumulated pcm and emits a tier:quality preview each cadence', async () => {
    nextQuality = async () => 'ship the release now';
    const vsid = await startPtt();
    // First chunk opens the STT (utterance active) + retains pcm.
    voiceSessionService.audioChunk({ voiceSessionId: vsid, seq: 0, pcm16: pcmChunk(1600) }, CLIENT);
    await jest.advanceTimersByTimeAsync(0); // let openStt resolve → stt active
    await jest.advanceTimersByTimeAsync(1200); // cadence tick → preview decode
    expect(qualityDecode).toHaveBeenCalled();
    expect(frameOfType('voice:partial')?.payload).toEqual({
      text: 'ship the release now',
      tier: 'quality',
      utteranceSeq: 1,
    });
  });

  it('normalizes the casing on both tiers (live all-caps → cased; quality passthrough)', async () => {
    nextQuality = async () => 'Ship the release now.'; // Moonshine already cased
    const vsid = await startPtt();
    voiceSessionService.audioChunk({ voiceSessionId: vsid, seq: 0, pcm16: pcmChunk(1600) }, CLIENT);
    await jest.advanceTimersByTimeAsync(0);
    // Past the partial throttle (Date.now starts at 0 under fake timers), below
    // the 1200ms cadence so only the live frame emits here.
    await jest.advanceTimersByTimeAsync(300);
    capturedOnPartial?.('SHIP THE RELEASE NOW'); // zipformer ALL-CAPS
    expect(frameOfType('voice:partial')?.payload).toEqual({
      text: 'Ship the release now',
      tier: 'live',
      utteranceSeq: 1,
    });
    // …then the quality cadence upgrade (normalizer passthrough on cased text).
    await jest.advanceTimersByTimeAsync(900); // total 1200 → cadence tick
    expect(frameOfType('voice:partial')?.payload).toEqual({
      text: 'Ship the release now.',
      tier: 'quality',
      utteranceSeq: 1,
    });
  });

  it('never runs more than one preview decode in flight', async () => {
    let releaseQ: ((s: string) => void) | undefined;
    nextQuality = () => new Promise<string>((r) => (releaseQ = r)); // decode hangs
    const vsid = await startPtt();
    voiceSessionService.audioChunk({ voiceSessionId: vsid, seq: 0, pcm16: pcmChunk(1600) }, CLIENT);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1200); // tick 1 → decode starts, hangs
    await jest.advanceTimersByTimeAsync(1200); // tick 2 → skipped (in flight)
    expect(qualityDecode).toHaveBeenCalledTimes(1);
    releaseQ?.('done');
    await jest.advanceTimersByTimeAsync(0);
  });

  it('caps a preview re-decode at the last ~20s of pcm', async () => {
    let captured: Int16Array | undefined;
    qualityDecode.mockImplementationOnce(async (pcm: Int16Array) => {
      captured = pcm;
      return 'tail';
    });
    const vsid = await startPtt();
    // 25 s of pcm in one chunk — the preview re-decodes only the last 20 s.
    voiceSessionService.audioChunk(
      { voiceSessionId: vsid, seq: 0, pcm16: pcmChunk(16_000 * 25) },
      CLIENT
    );
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1200);
    expect(captured?.length).toBe(16_000 * 20);
  });

  it('env SNAGLET_VOICE_PREVIEW_DECODE_MS=0 disables the cadence entirely', async () => {
    process.env.SNAGLET_VOICE_PREVIEW_DECODE_MS = '0';
    nextQuality = async () => 'should never appear';
    const vsid = await startPtt();
    voiceSessionService.audioChunk({ voiceSessionId: vsid, seq: 0, pcm16: pcmChunk(1600) }, CLIENT);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(6000);
    expect(qualityDecode).not.toHaveBeenCalled();
    expect(frameOfType('voice:partial')).toBeUndefined();
  });

  it('does not decode when no utterance is active (no audio fed)', async () => {
    nextQuality = async () => 'nothing to see';
    await startPtt();
    await jest.advanceTimersByTimeAsync(3600); // 3 cadence windows, no audio
    expect(qualityDecode).not.toHaveBeenCalled();
  });
});

describe('open-mic (mode open)', () => {
  it('creates a VAD session on start and loads its model with one silent probe frame', async () => {
    await startOpenSession({ participants: ['agent-A'] });
    expect(vadProcess).toHaveBeenCalledTimes(1); // the probe — no audio yet
    expect(vadProcess).toHaveBeenCalledWith(new Float32Array(512));
  });

  it('endpoints on silence and dispatches the utterance (no floor held)', async () => {
    nextTranscript = 'what is the weather';
    const vsid = await startOpenSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    await feedOpen(vsid, 0.9, 20); // ~640ms voiced → speech-start + voiced
    await feedOpen(vsid, 0.02, 12); // ~380ms silence → endpoint
    expect(processChatSend).toHaveBeenCalledTimes(1);
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toBe('what is the weather @Nova');
  });

  it('broadcasts voice:interrupt on onset while an agent holds the floor', async () => {
    currentFloorHolder.mockReturnValue('agent-A');
    currentFloorUtteranceId.mockReturnValue('utt-1');
    const vsid = await startOpenSession({ participants: ['agent-A'] });
    await feedOpen(vsid, 0.9, 4); // onset
    const interrupt = frameOfType('voice:interrupt');
    expect(interrupt?.payload).toEqual({ voiceSessionId: vsid, utteranceId: 'utt-1' });
  });

  it('backchannel: short burst resumes playback (voice:floor) and does not dispatch', async () => {
    currentFloorHolder.mockReturnValue('agent-A');
    currentFloorUtteranceId.mockReturnValue('utt-1');
    nextTranscript = 'mhm';
    const vsid = await startOpenSession({ participants: ['agent-A'] });
    await feedOpen(vsid, 0.9, 6); // ~192ms voiced (< 500ms backchannel floor)
    await feedOpen(vsid, 0.02, 12); // silence → endpoint (backchannel)
    expect(processChatSend).not.toHaveBeenCalled();
    // Re-broadcast of the floor holder = resume signal for the paused client.
    const floor = frameOfType('voice:floor');
    expect(floor?.payload).toEqual({ holder: 'agent-A' });
  });

  it('real barge-in: meaningful utterance clears the floor + routes to the interrupted agent', async () => {
    currentFloorHolder.mockReturnValue('agent-A');
    currentFloorUtteranceId.mockReturnValue('utt-1');
    clearFloorForBargeIn.mockReturnValue('agent-A');
    isToolInFlight.mockReturnValue(true); // mid-tool → inject (no abort)
    nextTranscript = 'no do the other thing';
    const vsid = await startOpenSession({
      participants: ['agent-A', 'agent-B'],
      targetAgentIds: ['agent-B'],
    });
    await feedOpen(vsid, 0.9, 20); // ~640ms voiced (real)
    await feedOpen(vsid, 0.02, 12); // silence → endpoint
    expect(clearFloorForBargeIn).toHaveBeenCalledWith(THREAD);
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toContain('no do the other thing');
    expect(payload.message).toContain('@Nova'); // interrupted agent
    expect(payload.message).not.toContain('@Vega'); // not the standing pill
  });

  it('refuses the session, with the reason, when the VAD model cannot load', async () => {
    // A missing model fails on the first frame the VAD sees. Before the probe,
    // that frame was real audio and the failure only reached the server log:
    // the mic looked live and nothing was ever transcribed.
    vadProcess.mockRejectedValueOnce(new Error("The voice detection model isn't installed."));
    threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue([{ agentId: 'agent-A' }]);
    await voiceSessionService.start(
      { threadId: THREAD, mode: 'open', dictate: true, speak: false, requestId: 'req-1' },
      CLIENT
    );
    await settle();

    expect(frameOfType('voice:error')?.payload).toEqual({
      message: "Voice input can't start: The voice detection model isn't installed.",
      speakable: false,
      requestId: 'req-1',
    });
    expect(frameOfType('voice:session:started')).toBeUndefined();
    expect(vadClose).toHaveBeenCalled();
    expect(warmup).not.toHaveBeenCalled();
    // The refused session holds nothing: a stray audio frame is ignored.
    voiceSessionService.audioChunk({ voiceSessionId: 'any', seq: 0, pcm16: audioB64 }, CLIENT);
    expect(fedFrames).toHaveLength(0);
  });

  it('tells the user once when VAD frames start failing mid-session', async () => {
    const vsid = await startOpenSession({ participants: ['agent-A'] });
    vadProcess.mockRejectedValue(new Error('inference failed'));
    await feedOpen(vsid, 0.9, 2);
    await feedOpen(vsid, 0.9, 2);
    vadProcess.mockImplementation(async () => vadProb);

    const errors = (broadcastToChannel.mock.calls as unknown as Array<[string, VoiceFrame]>)
      .map(([, frame]) => frame)
      .filter((frame) => frame.type === 'voice:error');
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!.payload.message)).toContain('inference failed');
  });

  it('closes the VAD session on teardown', async () => {
    const vsid = await startOpenSession({ participants: ['agent-A'] });
    voiceSessionService.stop({ voiceSessionId: vsid }, CLIENT);
    await tick();
    expect(vadClose).toHaveBeenCalled();
  });

  it('shuts down the process-wide engine when the last session stops', async () => {
    const vsid = await startOpenSession({ participants: ['agent-A'] });
    voiceSessionService.stop({ voiceSessionId: vsid }, CLIENT);
    await tick();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('shuts down the process-wide engine when the last client disconnects', async () => {
    await startOpenSession({ participants: ['agent-A'] });
    voiceSessionService.handleDisconnect(CLIENT);
    await tick();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('open-mic dispatch handoff', () => {
  it('a slow send never stalls VAD frame processing (dispatch runs off the VAD chain)', async () => {
    let release: (() => void) | undefined;
    processChatSend.mockImplementation(() => new Promise<void>((r) => (release = r)));
    nextTranscript = 'first utterance';
    const vsid = await startOpenSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    await feedOpen(vsid, 0.9, 20); // speech-start + voiced
    await feedOpen(vsid, 0.02, 12); // silence → endpoint → dispatch enqueued (hangs)
    expect(processChatSend).toHaveBeenCalledTimes(1);

    const vadCallsBefore = vadProcess.mock.calls.length;
    await feedOpen(vsid, 0.9, 10); // more audio while the send is still pending
    // VAD advanced — the chain is not blocked behind the slow send.
    expect(vadProcess.mock.calls.length).toBeGreaterThan(vadCallsBefore);

    release?.();
    await settle();
  });

  it('serializes dispatches so two rapid utterances send in order', async () => {
    const order: string[] = [];
    const releasers: Array<() => void> = [];
    processChatSend.mockImplementation(async (p: unknown) => {
      order.push((p as { message: string }).message);
      await new Promise<void>((r) => releasers.push(r));
    });
    const vsid = await startOpenSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });

    nextTranscript = 'first';
    await feedOpen(vsid, 0.9, 20);
    await feedOpen(vsid, 0.02, 12); // dispatch1 starts, hangs

    nextTranscript = 'second';
    await feedOpen(vsid, 0.9, 20);
    await feedOpen(vsid, 0.02, 12); // dispatch2 queued behind dispatch1 (serialized)

    expect(order).toEqual(['first @Nova']); // dispatch2 hasn't started yet

    releasers[0]?.();
    await settle();
    expect(order).toEqual(['first @Nova', 'second @Nova']); // in order
    releasers[1]?.();
    await settle();
  });
});

describe('open-mic VAD-chain bound', () => {
  it('drops overflow frames and warns once when the VAD chain saturates', async () => {
    const vsid = await startOpenSession({ participants: ['agent-A'] });
    // Freeze the VAD chain so links accumulate past the cap.
    let unblock: (() => void) | undefined;
    const gate = new Promise<void>((r) => (unblock = r));
    vadProcess.mockImplementation(async () => {
      await gate;
      return 0.02;
    });

    const overfeed = OPEN_MIC_MAX_PENDING_FRAMES + 25;
    for (let i = 0; i < overfeed; i++) {
      voiceSessionService.audioChunk(
        { voiceSessionId: vsid, seq: i, pcm16: openMicChunk(1) },
        CLIENT
      );
    }

    const overloadWarns = (LogsService.warn as jest.Mock).mock.calls.filter((c) =>
      String(c[0]).includes('overloaded')
    );
    expect(overloadWarns).toHaveLength(1); // warn once per session

    unblock?.();
    vadProcess.mockImplementation(async () => vadProb);
    await settle();
  });
});

describe('open-mic ignores client utterance:end', () => {
  it('no finalize + no dispatch on a stray client voice:utterance:end (recognizer survives)', async () => {
    const vsid = await startOpenSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    await feedOpen(vsid, 0.9, 6); // onset → in-speech, VAD-owned STT open
    await voiceSessionService.utteranceEnd({ voiceSessionId: vsid }, CLIENT);
    expect(processChatSend).not.toHaveBeenCalled();
    expect(frameOfType('voice:final')).toBeUndefined();

    // The VAD-owned recognizer is intact: a normal endpoint still dispatches once.
    nextTranscript = 'what is next';
    await feedOpen(vsid, 0.02, 12); // silence → endpoint → dispatch
    expect(processChatSend).toHaveBeenCalledTimes(1);
  });
});

describe('open-mic backchannel classification', () => {
  it('a short curt command ("stop") barges in + dispatches (not swallowed)', async () => {
    currentFloorHolder.mockReturnValue('agent-A');
    currentFloorUtteranceId.mockReturnValue('utt-1');
    clearFloorForBargeIn.mockReturnValue('agent-A');
    isToolInFlight.mockReturnValue(true); // mid-tool → inject (no abort)
    nextTranscript = 'stop';
    const vsid = await startOpenSession({ participants: ['agent-A'], targetAgentIds: ['agent-A'] });
    await feedOpen(vsid, 0.9, 12); // ~384ms voiced (< 500ms backchannel floor)
    await feedOpen(vsid, 0.02, 12); // silence → endpoint
    expect(clearFloorForBargeIn).toHaveBeenCalledWith(THREAD);
    expect(processChatSend).toHaveBeenCalledTimes(1);
    const [payload] = processChatSend.mock.calls[0] as unknown as [{ message: string }];
    expect(payload.message).toContain('stop');
    expect(payload.message).toContain('@Nova'); // routed to the interrupted agent
  });

  it('a short filler ("Mm-hmm.") resumes the speaker and does NOT dispatch', async () => {
    currentFloorHolder.mockReturnValue('agent-A');
    currentFloorUtteranceId.mockReturnValue('utt-1');
    nextTranscript = 'Mm-hmm.'; // case + punctuation → normalizes to a filler
    const vsid = await startOpenSession({ participants: ['agent-A'] });
    await feedOpen(vsid, 0.9, 12); // ~384ms voiced
    await feedOpen(vsid, 0.02, 12); // silence → endpoint
    expect(processChatSend).not.toHaveBeenCalled();
    expect(frameOfType('voice:floor')?.payload).toEqual({ holder: 'agent-A' }); // resume
  });

  it('an empty-transcript short burst resumes and does not dispatch', async () => {
    currentFloorHolder.mockReturnValue('agent-A');
    currentFloorUtteranceId.mockReturnValue('utt-1');
    nextTranscript = '';
    const vsid = await startOpenSession({ participants: ['agent-A'] });
    await feedOpen(vsid, 0.9, 8); // ~256ms voiced
    await feedOpen(vsid, 0.02, 12); // silence → endpoint
    expect(processChatSend).not.toHaveBeenCalled();
    expect(frameOfType('voice:floor')?.payload).toEqual({ holder: 'agent-A' });
  });
});

describe("dictation on Apple's recognizer (no local voice detection)", () => {
  const prepareStt = jest.fn<Promise<void>, []>(async () => {});
  const appleVad = jest.fn(async () => ({ process: vadProcess, close: vadClose }));
  const appleFinalize = jest.fn(async () => nextTranscript);
  let appleFed: Int16Array[] = [];
  let appleOnError: ((err: Error) => void) | null = null;
  const appleEngine: VoiceEngineApi = {
    sttEngine: 'apple',
    sttTier: 'quality',
    prepareStt,
    createSttSession: () => ({
      wantsNativeRate: true,
      feed: (pcm16: Int16Array) => appleFed.push(pcm16),
      onPartial: (cb: (text: string) => void) => {
        capturedOnPartial = cb;
      },
      onError: (cb: (err: Error) => void) => {
        appleOnError = cb;
      },
      finalize: appleFinalize,
      close: jest.fn(),
    }),
    synthesize: async function* () {
      /* never speaks */
    },
    createVadSession: appleVad,
    warmup,
    shutdown,
  };

  /** ~`ms` of 16 kHz pcm: loud (speech level) or digital silence. */
  function level(loud: boolean, ms: number): string {
    const pcm = new Int16Array((16_000 * ms) / 1000);
    if (loud) for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 === 0 ? 8000 : -8000;
    return Buffer.from(pcm.buffer).toString('base64');
  }
  async function say(vsid: string, ms: number): Promise<void> {
    voiceSessionService.audioChunk(
      { voiceSessionId: vsid, seq: 0, pcm16: level(true, ms) },
      CLIENT
    );
    await settle();
  }
  async function pause(vsid: string, ms: number): Promise<void> {
    voiceSessionService.audioChunk(
      { voiceSessionId: vsid, seq: 0, pcm16: level(false, ms) },
      CLIENT
    );
    await settle();
  }
  function frames(type: string): VoiceFrame[] {
    return (broadcastToChannel.mock.calls as unknown as Array<[string, VoiceFrame]>)
      .map(([, frame]) => frame)
      .filter((frame) => frame.type === type);
  }

  beforeEach(() => {
    __setVoiceEngineForTest(appleEngine);
    prepareStt.mockReset();
    prepareStt.mockResolvedValue(undefined);
    appleVad.mockReset();
    appleVad.mockResolvedValue({ process: vadProcess, close: vadClose });
    appleFed = [];
    appleOnError = null;
  });

  it('starts with no VAD probe and no model warmup, even with no voice models installed', async () => {
    appleVad.mockRejectedValue(new Error("The voice detection model isn't installed."));
    const vsid = await startOpenSession({ dictate: true, speak: false });

    expect(vsid).toBeTruthy();
    expect(frameOfType('voice:error')).toBeUndefined();
    expect(prepareStt).toHaveBeenCalledTimes(1);
    expect(appleVad).not.toHaveBeenCalled();
    expect(vadProcess).not.toHaveBeenCalled();
    expect(warmup).not.toHaveBeenCalled();
  });

  it('ends an utterance after a pause and drops it into the composer draft (never sent)', async () => {
    const vsid = await startOpenSession({
      dictate: true,
      speak: false,
      targetAgentIds: ['agent-A'],
    });
    nextTranscript = 'Buy milk tomorrow.';
    await say(vsid, 700);
    expect(frameOfType('voice:final')).toBeUndefined(); // still talking
    await pause(vsid, 1200);

    expect(appleFinalize).toHaveBeenCalledTimes(1);
    expect(frameOfType('voice:final')?.payload).toEqual({
      text: 'Buy milk tomorrow.',
      messageId: null,
      utteranceSeq: 1,
    });
    expect(processChatSend).not.toHaveBeenCalled();
    // Native-rate audio streamed straight to Apple, the pause included.
    expect(appleFed.length).toBeGreaterThan(0);
  });

  it('keeps listening: the next utterance gets its own key', async () => {
    const vsid = await startOpenSession({ dictate: true, speak: false });
    nextTranscript = 'First thought.';
    await say(vsid, 500);
    await pause(vsid, 1200);
    nextTranscript = 'Second thought.';
    await say(vsid, 500);
    await pause(vsid, 1200);

    expect(frames('voice:final').map((f) => [f.payload.text, f.payload.utteranceSeq])).toEqual([
      ['First thought.', 1],
      ['Second thought.', 2],
    ]);
  });

  it('a pause shorter than the silence window does not end the utterance', async () => {
    // This file pins the window to 300 ms (see the constants mock at the top).
    const vsid = await startOpenSession({ dictate: true, speak: false });
    await say(vsid, 500);
    await pause(vsid, 200);
    await say(vsid, 500);
    expect(frameOfType('voice:final')).toBeUndefined();
    await pause(vsid, 400);
    expect(frameOfType('voice:final')?.payload.utteranceSeq).toBe(1);
  });

  it('shows every Apple partial live (no throttle on its bursts)', async () => {
    const vsid = await startOpenSession({ dictate: true, speak: false });
    await say(vsid, 300);
    capturedOnPartial?.('Buy milk');
    capturedOnPartial?.('Buy milk tomorrow');
    expect(frames('voice:partial').map((f) => f.payload)).toEqual([
      { text: 'Buy milk', tier: 'quality', utteranceSeq: 1 },
      { text: 'Buy milk tomorrow', tier: 'quality', utteranceSeq: 1 },
    ]);
  });

  it("refuses with Apple's reason, not the voice-models message, when Apple speech can't run", async () => {
    prepareStt.mockRejectedValueOnce(
      new Error(
        'macOS is blocking speech recognition for Snaglet. Allow Snaglet in System Settings → ' +
          'Privacy & Security → Speech Recognition, then try again.'
      )
    );
    threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue([{ agentId: 'agent-A' }]);
    await voiceSessionService.start(
      { threadId: THREAD, mode: 'open', dictate: true, speak: false, requestId: 'req-1' },
      CLIENT
    );
    await settle();

    expect(frameOfType('voice:error')?.payload).toEqual({
      message:
        "Voice input can't start: macOS is blocking speech recognition for Snaglet. Allow Snaglet in " +
        'System Settings → Privacy & Security → Speech Recognition, then try again.',
      speakable: false,
      requestId: 'req-1',
    });
    expect(frameOfType('voice:session:started')).toBeUndefined();
    expect(appleVad).not.toHaveBeenCalled();
  });

  it('ends the session with the reason when Apple speech fails mid-dictation', async () => {
    const vsid = await startOpenSession({ dictate: true, speak: false });
    await say(vsid, 300);
    appleOnError?.(new Error("Apple's built-in speech recognition quit unexpectedly."));
    await settle();

    const calls = sendToClient.mock.calls as unknown as Array<[string, VoiceFrame]>;
    const ended = calls.find(([, f]) => f.type === 'voice:session:ended');
    expect(ended).toEqual([
      CLIENT,
      {
        type: 'voice:session:ended',
        payload: {
          voiceSessionId: vsid,
          reason: 'failed',
          message: "Dictation stopped: Apple's built-in speech recognition quit unexpectedly.",
        },
      },
    ]);
    // Torn down: more audio goes nowhere.
    const fedBefore = appleFed.length;
    await say(vsid, 300);
    expect(appleFed.length).toBe(fedBefore);
  });

  it('Voice mode on Apple still needs the voice-detection model (barge-in)', async () => {
    appleVad.mockRejectedValueOnce(
      new Error(
        "The voice detection model isn't installed. Install it from Settings → Local storage → " +
          'Install voice models.'
      )
    );
    threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue([{ agentId: 'agent-A' }]);
    await voiceSessionService.start(
      { threadId: THREAD, mode: 'open', dictate: true, speak: true, requestId: 'req-1' },
      CLIENT
    );
    await settle();

    expect(frameOfType('voice:error')?.payload.message).toBe(
      "Voice input can't start: The voice detection model isn't installed. Install it from " +
        'Settings → Local storage → Install voice models.'
    );
    expect(prepareStt).not.toHaveBeenCalled();
  });

  it("on a Mac without Apple's speech helper, the refusal says why Apple speech wasn't used", async () => {
    __setVoiceEngineForTest({
      ...fakeEngine,
      sttFallbackReason:
        "Apple's built-in speech recognition isn't available because Snaglet's speech helper is " +
        'missing (reinstalling Snaglet restores it)',
    });
    vadProcess.mockRejectedValueOnce(new Error("The voice detection model isn't installed."));
    await startOpenSessionOrNull();

    expect(frameOfType('voice:error')?.payload.message).toBe(
      "Voice input can't start: Apple's built-in speech recognition isn't available because " +
        "Snaglet's speech helper is missing (reinstalling Snaglet restores it), and Snaglet's own voice " +
        "detection couldn't load: The voice detection model isn't installed."
    );
  });

  /** Start a dictate-only open session that may be refused. */
  async function startOpenSessionOrNull(): Promise<void> {
    threadsFindById.mockResolvedValue({ id: THREAD, dispatchMode: 'mentioned' });
    participantsList.mockResolvedValue([{ agentId: 'agent-A' }]);
    await voiceSessionService.start(
      { threadId: THREAD, mode: 'open', dictate: true, speak: false },
      CLIENT
    );
    await settle();
  }
});
