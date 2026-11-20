/**
 * Open-mic dictation on Apple's recognizer, end to end through VoiceSessionService
 * with the real composite engine: Apple STT over the fake sidecar
 * (tests/support/fake-apple-stt.mjs, the exact wire contract) and the local
 * engine on a fake worker whose voice-detection model is "not installed".
 * Proves dictation needs no local model: no VAD probe, utterances end on a
 * pause, Apple's final lands as the draft, and the mic keeps listening.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: async (id: string) => ({ id, dispatchMode: 'mentioned' }) },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: async () => [{ agentId: 'test-agent-a' }] },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { findById: jest.fn(), listRecentByThreadId: jest.fn(async () => []) },
}));
jest.mock('@server/services/SocketService/store', () => ({ setSession: async () => {} }));
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: async (id: string) => ({ id, name: 'Test Agent' }) },
}));
const processChatSend = jest.fn(async () => {});
jest.mock('@server/services/SocketService/handlers/chatHandlers', () => ({
  processChatSend: (...a: unknown[]) => processChatSend(...(a as [])),
}));
jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitVoiceModeEnabledEvent: jest.fn(async () => {}),
  emitVoiceModeDisabledEvent: jest.fn(async () => {}),
}));

import { VoiceEngineService, type WorkerLike } from '@server/services/voice/VoiceEngineService';
import type { EngineRequest, EngineResponse } from '@server/services/voice/voiceEngineProtocol';
import { AppleSttEngine } from '@server/services/voice/appleSttEngine';
import {
  buildCompositeAdapter,
  __setVoiceEngineForTest,
} from '@server/services/SocketService/voiceSession/engineAdapter';
import { voiceSessionService } from '@server/services/SocketService/voiceSession/VoiceSessionService';

// Real subprocesses (the fake sidecar): leave room for a loaded machine.
jest.setTimeout(20_000);

const FAKE_SIDECAR = join(process.cwd(), 'tests', 'support', 'fake-apple-stt.mjs');
const THREAD = 'thread-1111111111111-aaaaaaaaa';
const CLIENT = 'client-1';
const RATE = 48_000;

/** The local engine's worker: its voice-detection model is not installed. */
class NoModelsWorker implements WorkerLike {
  private messageCb: ((msg: EngineResponse) => void) | null = null;
  constructor() {
    queueMicrotask(() => this.messageCb?.({ kind: 'ready' }));
  }
  postMessage(value: unknown): void {
    const req = value as EngineRequest;
    queueMicrotask(() =>
      this.messageCb?.({
        kind: 'error',
        reqId: req.reqId,
        message: "The voice detection model isn't installed.",
      })
    );
  }
  on(event: 'message' | 'error' | 'exit', listener: (arg: never) => void): void {
    if (event === 'message') this.messageCb = listener as (m: EngineResponse) => void;
  }
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
}

interface Frame {
  type: string;
  payload: Record<string, unknown>;
}

function framesOf(type: string): Frame[] {
  return (broadcastToChannel.mock.calls as unknown as Array<[string, Frame]>)
    .map(([, frame]) => frame)
    .filter((frame) => frame.type === type);
}

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** One 100 ms chunk at the native rate: speech level or silence. */
function chunk(loud: boolean): string {
  const pcm = new Int16Array(RATE / 10);
  if (loud) for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 === 0 ? 8000 : -8000;
  return Buffer.from(pcm.buffer).toString('base64');
}

function feed(vsid: string, loud: boolean, chunks: number): void {
  for (let i = 0; i < chunks; i++) {
    voiceSessionService.audioChunk(
      { voiceSessionId: vsid, seq: i, pcm16: chunk(loud), sampleRate: RATE },
      CLIENT
    );
  }
}

function makeEngine(sidecarArgs: string[]) {
  const svc = new VoiceEngineService({ workerFactory: () => new NoModelsWorker() });
  const vadCreate = jest.spyOn(svc, 'createVadSession');
  const vadProb = jest.spyOn(svc, 'vadProbability');
  const synth = jest.spyOn(svc, 'synthesize');
  let streamSpawns = 0;
  const spawnSpy = ((cmd: string, args: readonly string[]) => {
    if (args.includes('stream')) streamSpawns += 1;
    return spawn(cmd, args as string[]);
  }) as unknown as typeof spawn;
  const apple = new AppleSttEngine({
    command: process.execPath,
    prefixArgs: [FAKE_SIDECAR, ...sidecarArgs],
    spawn: spawnSpy,
    restartBackoffMs: 0,
    finalizeTimeoutMs: 2_000,
  });
  __setVoiceEngineForTest(buildCompositeAdapter(svc, apple));
  return { apple, vadCreate, vadProb, synth, streamSpawns: () => streamSpawns };
}

async function startDictation(requestId = 'req-1'): Promise<void> {
  await voiceSessionService.start(
    { threadId: THREAD, mode: 'open', dictate: true, speak: false, requestId },
    CLIENT
  );
}

function startedId(): string | undefined {
  return framesOf('voice:session:started')[0]?.payload.voiceSessionId as string | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(async () => {
  voiceSessionService.__reset();
  await new Promise((r) => setTimeout(r, 30)); // let the sidecar exit
});

describe("open-mic dictation on Apple's recognizer (fake sidecar)", () => {
  it('needs no voice-detection model: pauses end utterances, finals land as drafts, the mic keeps listening', async () => {
    const { apple, vadCreate, vadProb, synth, streamSpawns } = makeEngine([
      '--final',
      'Buy milk tomorrow.',
    ]);
    await startDictation();
    const vsid = startedId();
    expect(vsid).toBeTruthy();
    expect(framesOf('voice:error')).toEqual([]);

    // Speech: live partials (Apple tier) for the first utterance.
    feed(vsid!, true, 7);
    await waitFor(() => framesOf('voice:partial').length > 0);
    expect(framesOf('voice:partial')[0]!.payload).toMatchObject({
      tier: 'quality',
      utteranceSeq: 1,
    });

    // A pause ends it: finalize → Apple's final → the composer draft.
    feed(vsid!, false, 12);
    await waitFor(() => framesOf('voice:final').length === 1);
    expect(framesOf('voice:final')[0]!.payload).toEqual({
      text: 'Buy milk tomorrow.',
      messageId: null,
      utteranceSeq: 1,
    });

    // Still listening: the next utterance on the same sidecar process.
    feed(vsid!, true, 5);
    feed(vsid!, false, 12);
    await waitFor(() => framesOf('voice:final').length === 2);
    expect(framesOf('voice:final')[1]!.payload.utteranceSeq).toBe(2);
    expect(streamSpawns()).toBe(1);

    // Dictation never sends, and never touched the local models.
    expect(processChatSend).not.toHaveBeenCalled();
    expect(vadCreate).not.toHaveBeenCalled();
    expect(vadProb).not.toHaveBeenCalled();
    expect(synth).not.toHaveBeenCalled();
    await apple.shutdown();
  });

  it("refuses with Apple's own reason when Apple speech can't run", async () => {
    const { vadCreate } = makeEngine(['--fail-code', 'not-authorized']);
    await startDictation('req-2');

    expect(framesOf('voice:error').map((f) => f.payload)).toEqual([
      {
        message:
          "Voice input can't start: macOS is blocking speech recognition for Snaglet. Allow Snaglet in " +
          'System Settings → Privacy & Security → Speech Recognition, then try again.',
        speakable: false,
        requestId: 'req-2',
      },
    ]);
    expect(startedId()).toBeUndefined();
    expect(vadCreate).not.toHaveBeenCalled();
  });

  it('ends the session with the reason when the sidecar dies mid-dictation', async () => {
    makeEngine(['--crash-after-frames', '3']);
    await startDictation();
    const vsid = startedId()!;
    feed(vsid, true, 5);
    await waitFor(() =>
      (sendToClient.mock.calls as unknown as Array<[string, Frame]>).some(
        ([, f]) => f.type === 'voice:session:ended'
      )
    );
    const ended = (sendToClient.mock.calls as unknown as Array<[string, Frame]>).find(
      ([, f]) => f.type === 'voice:session:ended'
    );
    expect(ended).toEqual([
      CLIENT,
      {
        type: 'voice:session:ended',
        payload: {
          voiceSessionId: vsid,
          reason: 'failed',
          message:
            "Dictation stopped: Apple's built-in speech recognition quit unexpectedly. " +
            'Turn Dictation off and on to try again.',
        },
      },
    ]);
  });
});
