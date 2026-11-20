/**
 * Voice route — pins the /speak-message contract (per-message re-listen): it
 * must mirror /preview's shape (engine-unavailable → 503, unsynthesizable voice
 * → 503, buffered WAV response) while resolving voice differently — an agentId
 * resolves via resolveAgentVoiceId; an absent one (the user-message re-listen
 * case, which has no agent to look up) falls back to DEFAULT_VOICE_ID directly,
 * same as an agentId that resolves to nothing.
 */
import request from 'supertest';
import express from 'express';
import type { TtsChunk, VoiceEngineApi } from '@server/services/SocketService/voiceSession/types';

const mockGetVoiceEngine = jest.fn();
const mockResolveAgentVoiceId = jest.fn();
const mockFetchVoiceModels = jest.fn();
const mockSetLocalModelEnabled = jest.fn();
const mockGetDisabledLocalModels = jest.fn();
// `access` drives voiceFilesReady(): rejecting = a model file is missing
// (not-installed), resolving = all present (ready). Flip it per test so the
// install/status suite never touches a real ~/.snaglet.
let accessResolves = false;
jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'),
  access: jest.fn(() => (accessResolves ? Promise.resolve() : Promise.reject(new Error('ENOENT')))),
}));

jest.mock('@server/services/SocketService/voiceSession/engineAdapter', () => ({
  getVoiceEngine: (...args: unknown[]) => mockGetVoiceEngine(...args),
  // The capabilities route imports this for its no-engine fallback.
  piperVoiceInfos: () => [
    {
      id: 'en_US-amy-medium',
      engine: 'piper',
      name: 'Amy',
      quality: 'standard',
      lang: 'en-US',
    },
  ],
}));
jest.mock('@server/services/SocketService/voiceSession/resolveAgentVoice', () => ({
  resolveAgentVoiceId: (...args: unknown[]) => mockResolveAgentVoiceId(...args),
}));

// Keep the install suite fully offline: the real download logic is never run,
// and `expectedVoiceModelBytes` is pinned so progress math is deterministic.
jest.mock('@server/services/voice/fetchVoiceModels', () => ({
  fetchVoiceModels: (...args: unknown[]) => mockFetchVoiceModels(...args),
  expectedVoiceModelBytes: () => 1000,
}));
jest.mock('@server/services/localModels/localModelPreferences', () => ({
  setLocalModelEnabled: (...args: unknown[]) => mockSetLocalModelEnabled(...args),
  getDisabledLocalModels: (...args: unknown[]) => mockGetDisabledLocalModels(...args),
}));
// Which voices are installed comes from disk; here it follows `accessResolves`
// (every file present → `installedVoices`) unless a test sets it directly.
let installedVoices: string[] = ['en_US-amy-medium'];
const mockInstalledVoiceIds = jest.fn(async () => (accessResolves ? installedVoices : []));
jest.mock('@server/services/voice/installedVoices', () => ({
  ...jest.requireActual('@server/services/voice/installedVoices'),
  installedVoiceIds: () => mockInstalledVoiceIds(),
}));
const mockSpeakingVoiceId = jest.fn(async (id: string) => id);
jest.mock('@server/services/SocketService/voiceSession/speakingVoice', () => ({
  speakingVoiceId: (id: string) => mockSpeakingVoiceId(id),
}));
const mockClearVoiceStorageModel = jest.fn();
const mockGetVoiceStorage = jest.fn();
jest.mock('@server/services/snagletHome', () => ({
  clearSnagletVoiceStorageModel: (...args: unknown[]) => mockClearVoiceStorageModel(...args),
  getSnagletVoiceStorage: (...args: unknown[]) => mockGetVoiceStorage(...args),
}));

import voiceRouter, { __resetVoiceInstallStateForTest } from '@server/routes/voice';
import { DEFAULT_VOICE_ID } from '@server/services/SocketService/voiceSession/constants';

/** A fake engine whose `synthesize` yields the given frames (or throws). */
function fakeEngine(frames: TtsChunk[] | 'throw'): VoiceEngineApi {
  return {
    createSttSession: () => {
      throw new Error('not used in this suite');
    },
    async *synthesize() {
      if (frames === 'throw') throw new Error('model unavailable');
      for (const f of frames) yield f;
    },
  } as unknown as VoiceEngineApi;
}

function pcm(n: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 100;
  return out;
}

describe('voice routes: POST /api/voice/speak-message', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/voice', voiceRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a WAV for an agentId, resolving its voice via resolveAgentVoiceId', async () => {
    mockGetVoiceEngine.mockResolvedValue(fakeEngine([{ pcm16: pcm(1_600), sampleRate: 22_050 }]));
    mockResolveAgentVoiceId.mockResolvedValue('en_US-amy-medium');

    const res = await request(app)
      .post('/api/voice/speak-message')
      .send({ agentId: 'agent-1', text: 'hello from the agent' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(Buffer.from(res.body).slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(mockResolveAgentVoiceId).toHaveBeenCalledWith('agent-1');
  });

  it('uses DEFAULT_VOICE_ID and skips resolveAgentVoiceId when agentId is absent (user-message case)', async () => {
    mockGetVoiceEngine.mockResolvedValue(fakeEngine([{ pcm16: pcm(800), sampleRate: 22_050 }]));

    const res = await request(app)
      .post('/api/voice/speak-message')
      .send({ text: 'hello from the user' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(mockResolveAgentVoiceId).not.toHaveBeenCalled();
  });

  it('also falls back to the default voice for a blank agentId string', async () => {
    mockGetVoiceEngine.mockResolvedValue(fakeEngine([{ pcm16: pcm(400), sampleRate: 22_050 }]));

    const res = await request(app)
      .post('/api/voice/speak-message')
      .send({ agentId: '   ', text: 'still speaks' });

    expect(res.status).toBe(200);
    expect(mockResolveAgentVoiceId).not.toHaveBeenCalled();
  });

  it('503s when the voice engine is unavailable — mirrors /preview', async () => {
    mockGetVoiceEngine.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/voice/speak-message')
      .send({ agentId: 'agent-1', text: 'hello' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('voice engine unavailable');
    // Never gets far enough to resolve a voice.
    expect(mockResolveAgentVoiceId).not.toHaveBeenCalled();
  });

  it('503s with "voice model unavailable" when synthesis throws — mirrors /preview', async () => {
    mockGetVoiceEngine.mockResolvedValue(fakeEngine('throw'));
    mockResolveAgentVoiceId.mockResolvedValue('en_US-ryan-medium');

    const res = await request(app)
      .post('/api/voice/speak-message')
      .send({ agentId: 'agent-2', text: 'hello' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('voice model unavailable: en_US-ryan-medium');
  });

  it('400s when text is missing or blank — unlike /preview, there is no filler default', async () => {
    mockGetVoiceEngine.mockResolvedValue(fakeEngine([]));

    const missing = await request(app).post('/api/voice/speak-message').send({ agentId: 'a' });
    expect(missing.status).toBe(400);

    const blank = await request(app)
      .post('/api/voice/speak-message')
      .send({ agentId: 'a', text: '   ' });
    expect(blank.status).toBe(400);
  });

  it('caps text length so a pathologically long message cannot hang synthesis', async () => {
    let capturedText = '';
    mockGetVoiceEngine.mockResolvedValue({
      async *synthesize(text: string) {
        capturedText = text;
        yield { pcm16: pcm(100), sampleRate: 22_050 };
      },
    } as unknown as VoiceEngineApi);

    const longText = 'x'.repeat(5_000);
    const res = await request(app).post('/api/voice/speak-message').send({ text: longText });

    expect(res.status).toBe(200);
    expect(capturedText.length).toBeLessThan(longText.length);
    expect(capturedText.length).toBe(2_000);
  });

  it('strips markdown before synthesis — reuses the auto voice-mode sanitizer', async () => {
    const capturedTexts: string[] = [];
    mockGetVoiceEngine.mockResolvedValue({
      async *synthesize(text: string) {
        capturedTexts.push(text);
        yield { pcm16: pcm(100), sampleRate: 22_050 };
      },
    } as unknown as VoiceEngineApi);

    const res = await request(app)
      .post('/api/voice/speak-message')
      .send({ text: '**bold** and _italic_ and `code` here.\n# Heading' });

    expect(res.status).toBe(200);
    const spoken = capturedTexts.join(' ');
    // No literal markdown artifacts read aloud (asterisks, underscores,
    // backticks, heading hashes) — matches cleanProseForSpeech's contract
    // (tests/unit/apps/server/services/voice/speakabilityFilter.test.ts).
    expect(spoken).not.toMatch(/[*_#`]/);
    expect(spoken).toContain('bold');
    expect(spoken).toContain('italic');
    expect(spoken).toContain('code');
    expect(spoken).toContain('Heading');
  });

  it('resolves DEFAULT_VOICE_ID for the user-message case (sanity on the constant itself)', () => {
    expect(typeof DEFAULT_VOICE_ID).toBe('string');
    expect(DEFAULT_VOICE_ID.length).toBeGreaterThan(0);
  });
});

describe('voice routes: voice-model install + status', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/voice', voiceRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    accessResolves = false;
    installedVoices = ['en_US-amy-medium'];
    mockSetLocalModelEnabled.mockResolvedValue(undefined);
    mockGetDisabledLocalModels.mockResolvedValue(new Set());
    // Install state is module-level (process-lifetime by design); reset it so
    // one test's in-flight/failed install never leaks into the next.
    __resetVoiceInstallStateForTest();
  });

  it('reports not-installed when no models are on disk and no install is running', async () => {
    const res = await request(app).get('/api/voice/models/status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('not-installed');
  });

  it('reports ready (no progress fields) when the model files are present', async () => {
    accessResolves = true;
    const res = await request(app).get('/api/voice/models/status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ready');
    expect(res.body.percent).toBeUndefined();
  });

  // Item 1: per-mode / per-engine capabilities in the status response

  it('reports local-engine needs for both modes when no Apple engine (non-Mac / forced local)', async () => {
    // No engine mocked → getVoiceEngine resolves undefined → STT engine 'local'.
    const res = await request(app).get('/api/voice/models/status');
    expect(res.body.capabilities).toEqual({
      sttEngine: 'local',
      // Dictation on the all-local engine needs STT + VAD; nothing on disk → not ready.
      dictate: { needs: ['stt', 'vad'], ready: false },
      // Voice mode needs STT + VAD + TTS on a non-Mac.
      speak: { needs: ['stt', 'vad', 'tts'], ready: false },
    });
  });

  it('local engine: both modes ready once every component is present', async () => {
    accessResolves = true;
    const res = await request(app).get('/api/voice/models/status');
    expect(res.body.state).toBe('ready');
    expect(res.body.capabilities.sttEngine).toBe('local');
    expect(res.body.capabilities.dictate.ready).toBe(true);
    expect(res.body.capabilities.speak.ready).toBe(true);
  });

  it('Apple engine (macOS): Dictation needs nothing and is ready with no models; Voice mode needs VAD + TTS', async () => {
    mockGetVoiceEngine.mockResolvedValue({ sttEngine: 'apple' } as unknown as VoiceEngineApi);
    const res = await request(app).get('/api/voice/models/status');
    expect(res.body.capabilities.sttEngine).toBe('apple');
    // Dictation uses Apple speech — no local component, ready even with nothing on disk.
    expect(res.body.capabilities.dictate).toEqual({ needs: [], ready: true });
    // Voice mode still needs VAD + TTS (never STT on a Mac); absent → not ready.
    expect(res.body.capabilities.speak).toEqual({ needs: ['vad', 'tts'], ready: false });
    // Overall 'ready' badge needs STT present too, so a Mac with no models is not 'ready'.
    expect(res.body.state).toBe('not-installed');
  });

  it('Apple engine: Voice mode becomes ready once VAD + TTS are present (STT absence does not matter)', async () => {
    mockGetVoiceEngine.mockResolvedValue({ sttEngine: 'apple' } as unknown as VoiceEngineApi);
    accessResolves = true;
    const res = await request(app).get('/api/voice/models/status');
    expect(res.body.capabilities.dictate.ready).toBe(true);
    expect(res.body.capabilities.speak.ready).toBe(true);
  });

  // Item 4: install answers at once (202), the status poll settles it

  it('answers 202 immediately without holding the request for the download', async () => {
    // A fetch that parks until released: if the route awaited it, the POST
    // would hang. It must return 202 right away instead.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockFetchVoiceModels.mockImplementation(async () => {
      await gate;
    });

    const res = await request(app).post('/api/voice/models/install');
    expect(res.status).toBe(202);
    expect(res.body.state).toBe('downloading');
    // The install is still running (never awaited by the route).
    expect(mockFetchVoiceModels).toHaveBeenCalledTimes(1);

    accessResolves = true;
    release();
    // Let the fetch settle + the .finally clear the in-flight install.
    await new Promise((r) => setTimeout(r, 20));
    const status = await request(app).get('/api/voice/models/status');
    expect(status.body.state).toBe('ready');
  });

  it('202 response carries the current capabilities so a caller can gate immediately', async () => {
    mockGetVoiceEngine.mockResolvedValue({ sttEngine: 'apple' } as unknown as VoiceEngineApi);
    mockFetchVoiceModels.mockImplementation(
      () => new Promise<void>(() => {}) // never resolves; we only assert the immediate answer
    );
    const res = await request(app).post('/api/voice/models/install');
    expect(res.status).toBe(202);
    expect(res.body.capabilities.sttEngine).toBe('apple');
    expect(res.body.capabilities.dictate.ready).toBe(true);
  });

  it('byte-accurate progress: status mid-download reports received/total/percent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockFetchVoiceModels.mockImplementation(
      async (opts: { onProgress?: (p: { bytes: number }) => void }) => {
        opts.onProgress?.({ bytes: 400 });
        await gate;
        opts.onProgress?.({ bytes: 600 });
      }
    );

    // 202 returns at once; the download keeps running in the background.
    const started = await request(app).post('/api/voice/models/install');
    expect(started.status).toBe(202);
    // Let the first onProgress chunk register.
    await new Promise((r) => setTimeout(r, 20));

    const mid = await request(app).get('/api/voice/models/status');
    expect(mid.body.state).toBe('downloading');
    expect(mid.body.receivedBytes).toBe(400);
    expect(mid.body.totalBytes).toBe(1000);
    expect(mid.body.percent).toBe(40);

    accessResolves = true; // files land as the fetch finishes
    release();
    await new Promise((r) => setTimeout(r, 20));
    // Every component is re-enabled after a successful install.
    expect(mockSetLocalModelEnabled).toHaveBeenCalled();
    // Progress state is cleared once the install settles.
    const after = await request(app).get('/api/voice/models/status');
    expect(after.body.state).toBe('ready');
    expect(after.body.percent).toBeUndefined();
  });

  it('a concurrent install request joins the running one instead of starting a second', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockFetchVoiceModels.mockImplementation(async () => {
      await gate;
    });

    const first = await request(app).post('/api/voice/models/install');
    expect(first.status).toBe(202);
    // Second POST while the first is in flight: 202 + current progress, and
    // crucially no second download kicked off.
    const second = await request(app).post('/api/voice/models/install');
    expect(second.status).toBe(202);
    expect(second.body.state).toBe('downloading');
    expect(mockFetchVoiceModels).toHaveBeenCalledTimes(1);

    accessResolves = true;
    release();
    await new Promise((r) => setTimeout(r, 20));
    const status = await request(app).get('/api/voice/models/status');
    expect(status.body.state).toBe('ready');
  });

  it('the status poll surfaces a failed download (install still answered 202)', async () => {
    mockFetchVoiceModels.mockRejectedValue(new Error('checksum mismatch'));
    const res = await request(app).post('/api/voice/models/install');
    // Item 4: the request is answered at once, even though the download fails.
    expect(res.status).toBe(202);
    expect(res.body.state).toBe('downloading');
    // Let the rejected fetch settle into voiceInstallError.
    await new Promise((r) => setTimeout(r, 20));
    const status = await request(app).get('/api/voice/models/status');
    expect(status.body.state).toBe('failed');
    expect(status.body.error).toContain('checksum mismatch');
  });

  // Item 5: plain-language network error + size from the manifest

  it('translates a connection failure into plain language', async () => {
    // Node's global fetch throws `TypeError: fetch failed` with a DNS/socket cause.
    const netErr = Object.assign(new TypeError('fetch failed'), {
      cause: new Error('getaddrinfo ENOTFOUND huggingface.co'),
    });
    mockFetchVoiceModels.mockRejectedValue(netErr);
    const res = await request(app).post('/api/voice/models/install');
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const status = await request(app).get('/api/voice/models/status');
    expect(status.body.state).toBe('failed');
    expect(status.body.error).toBe(
      "Couldn't reach the download server. Check your connection and retry."
    );
  });

  it('keeps a specific (non-network) failure message verbatim', async () => {
    mockFetchVoiceModels.mockRejectedValue(new Error('sha256 mismatch for encoder.onnx'));
    await request(app).post('/api/voice/models/install');
    await new Promise((r) => setTimeout(r, 20));
    const status = await request(app).get('/api/voice/models/status');
    expect(status.body.error).toContain('sha256 mismatch');
  });

  it('installs the base pieces plus the default voice (Amy) and nothing else', async () => {
    mockFetchVoiceModels.mockResolvedValue({ voices: [] });
    await request(app).post('/api/voice/models/install');
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetchVoiceModels).toHaveBeenCalledWith(
      expect.objectContaining({
        components: ['stt', 'vad', 'tts'],
        voiceIds: ['en_US-amy-medium'],
      })
    );
    expect(DEFAULT_VOICE_ID).toBe('en_US-amy-medium');
  });

  it('always reports the pinned install size so the UI computes it, never hardcodes', async () => {
    const res = await request(app).get('/api/voice/models/status');
    // Comes straight from expectedVoiceModelBytes (mocked to 1000 here); in
    // production that reads the manifest total (~469 MiB) so the UI's size text
    // is computed, not hardcoded.
    expect(res.body.expectedTotalBytes).toBe(1000);
  });
});

describe('voice routes: choosing which voices to install', () => {
  let app: express.Application;
  const AMY = 'en_US-amy-medium';
  const RYAN = 'en_US-ryan-medium';
  const ALAN = 'en_GB-alan-medium';

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/voice', voiceRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    accessResolves = true;
    installedVoices = [AMY];
    mockSetLocalModelEnabled.mockResolvedValue(undefined);
    mockGetDisabledLocalModels.mockResolvedValue(new Set());
    mockClearVoiceStorageModel.mockResolvedValue(undefined);
    mockGetVoiceStorage.mockResolvedValue([
      { id: `tts:${AMY}`, bytes: 63_000_000 },
      { id: `tts:${RYAN}`, bytes: 62_000_000 },
    ]);
    __resetVoiceInstallStateForTest();
  });

  const settle = () => new Promise((r) => setTimeout(r, 20));
  const voiceState = (body: { voices: Array<{ id: string; state: string }> }, id: string) =>
    body.voices.find((voice) => voice.id === id)?.state;

  it('lists every catalog voice with its language, quality, size and disk state', async () => {
    const res = await request(app).get('/api/voice/models/status');
    expect(res.body.defaultVoiceId).toBe(AMY);
    expect(res.body.voices.map((voice: { id: string }) => voice.id)).toEqual([
      AMY,
      RYAN,
      ALAN,
      'en_US-joe-medium',
    ]);
    expect(res.body.voices[0]).toMatchObject({
      id: AMY,
      name: 'Amy (US, warm)',
      lang: 'en-US',
      quality: 'medium',
      state: 'installed',
    });
    expect(res.body.voices[0].downloadBytes).toBeGreaterThan(60_000_000);
    expect(res.body.voices[2]).toMatchObject({ id: ALAN, lang: 'en-GB', state: 'not-installed' });
    // Every base piece is on disk, so an install adds only voices.
    expect(res.body.baseMissingBytes).toBe(0);
  });

  it('installs exactly the chosen voices with the base pieces, then enables them', async () => {
    mockFetchVoiceModels.mockResolvedValue({ voices: [] });
    const res = await request(app)
      .post('/api/voice/models/install')
      .send({ voiceIds: [ALAN, RYAN] });
    expect(res.status).toBe(202);
    // Catalog order, whatever order they were picked in.
    expect(mockFetchVoiceModels).toHaveBeenCalledWith(
      expect.objectContaining({ components: ['stt', 'vad', 'tts'], voiceIds: [RYAN, ALAN] })
    );
    expect(voiceState(res.body, RYAN)).toBe('installing');
    expect(voiceState(res.body, AMY)).toBe('installed');

    await settle();
    const enabled = mockSetLocalModelEnabled.mock.calls.map(([id]) => id);
    expect(enabled).toEqual(expect.arrayContaining([`tts:${RYAN}`, `tts:${ALAN}`, 'tts-espeak']));
    expect(enabled).not.toContain(`tts:${AMY}`);
  });

  it('an empty list installs the base pieces only', async () => {
    mockFetchVoiceModels.mockResolvedValue({ voices: [] });
    await request(app).post('/api/voice/models/install').send({ voiceIds: [] });
    expect(mockFetchVoiceModels).toHaveBeenCalledWith(expect.objectContaining({ voiceIds: [] }));
  });

  it('a first-use install with voices already on disk keeps those voices, not the default', async () => {
    installedVoices = [RYAN];
    mockFetchVoiceModels.mockResolvedValue({ voices: [] });
    await request(app).post('/api/voice/models/install');
    expect(mockFetchVoiceModels).toHaveBeenCalledWith(
      expect.objectContaining({ voiceIds: [RYAN] })
    );
  });

  it.each([
    [{ voiceIds: ['nope-voice'] }, 'Unknown voice: nope-voice'],
    [{ voiceIds: 'en_US-amy-medium' }, 'voiceIds must be a list of voice ids.'],
    [{ voiceIds: [42] }, 'voiceIds must be a list of voice ids.'],
  ])('rejects %j without downloading anything', async (body, error) => {
    const res = await request(app).post('/api/voice/models/install').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(mockFetchVoiceModels).not.toHaveBeenCalled();
  });

  it('refuses a different set of voices while an install runs, and joins the same set', async () => {
    mockFetchVoiceModels.mockImplementation(() => new Promise<void>(() => {}));
    await request(app)
      .post('/api/voice/models/install')
      .send({ voiceIds: [RYAN] });

    const other = await request(app)
      .post('/api/voice/models/install')
      .send({ voiceIds: [ALAN] });
    expect(other.status).toBe(409);
    const same = await request(app)
      .post('/api/voice/models/install')
      .send({ voiceIds: [RYAN] });
    expect(same.status).toBe(202);
    expect(mockFetchVoiceModels).toHaveBeenCalledTimes(1);
  });

  it('marks the voices of a failed install failed, with the error, until a retry installs them', async () => {
    mockFetchVoiceModels.mockRejectedValueOnce(new Error('sha256 mismatch for en_GB-alan.onnx'));
    await request(app)
      .post('/api/voice/models/install')
      .send({ voiceIds: [ALAN] });
    await settle();

    const failed = await request(app).get('/api/voice/models/status');
    expect(failed.body.voices.find((voice: { id: string }) => voice.id === ALAN)).toMatchObject({
      state: 'failed',
      error: 'sha256 mismatch for en_GB-alan.onnx',
    });
    expect(voiceState(failed.body, AMY)).toBe('installed');

    mockFetchVoiceModels.mockResolvedValue({ voices: [] });
    installedVoices = [AMY, ALAN];
    await request(app)
      .post('/api/voice/models/install')
      .send({ voiceIds: [ALAN] });
    await settle();
    const retried = await request(app).get('/api/voice/models/status');
    expect(voiceState(retried.body, ALAN)).toBe('installed');
  });

  it('uninstalls exactly the named voices and reports the space freed', async () => {
    installedVoices = [AMY, RYAN];
    const res = await request(app)
      .post('/api/voice/models/uninstall')
      .send({ voiceIds: [RYAN] });
    expect(res.status).toBe(200);
    expect(mockClearVoiceStorageModel.mock.calls).toEqual([[`tts:${RYAN}`]]);
    expect(res.body.freedBytes).toBe(62_000_000);
    expect(res.body.voices).toHaveLength(4);
  });

  it('uninstalls the default and the last voice too, never the shared pieces', async () => {
    const res = await request(app)
      .post('/api/voice/models/uninstall')
      .send({ voiceIds: [AMY] });
    expect(res.status).toBe(200);
    expect(mockClearVoiceStorageModel.mock.calls).toEqual([[`tts:${AMY}`]]);
    expect(mockFetchVoiceModels).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ voiceIds: [] }], [{ voiceIds: ['nope-voice'] }]])(
    'rejects an uninstall of %j',
    async (body) => {
      const res = await request(app).post('/api/voice/models/uninstall').send(body);
      expect(res.status).toBe(400);
      expect(mockClearVoiceStorageModel).not.toHaveBeenCalled();
    }
  );

  it('refuses an uninstall while an install runs', async () => {
    mockFetchVoiceModels.mockImplementation(() => new Promise<void>(() => {}));
    await request(app)
      .post('/api/voice/models/install')
      .send({ voiceIds: [RYAN] });
    const res = await request(app)
      .post('/api/voice/models/uninstall')
      .send({ voiceIds: [AMY] });
    expect(res.status).toBe(409);
    expect(mockClearVoiceStorageModel).not.toHaveBeenCalled();
  });

  it('with no voice installed, text-to-speech is missing exactly as with no voice files', async () => {
    installedVoices = [];
    const res = await request(app).get('/api/voice/models/status');
    expect(res.body.capabilities.speak.ready).toBe(false);
    expect(res.body.capabilities.dictate.ready).toBe(true);
    expect(res.body.state).toBe('not-installed');
    expect(
      res.body.voices.every((voice: { state: string }) => voice.state === 'not-installed')
    ).toBe(true);
  });

  it('a message without an agent speaks in the voice the default falls back to', async () => {
    mockSpeakingVoiceId.mockResolvedValueOnce(RYAN);
    const synthesize = jest.fn(async function* () {
      yield { pcm16: new Int16Array(10), sampleRate: 22_050 };
    });
    mockGetVoiceEngine.mockResolvedValue({ synthesize } as unknown as VoiceEngineApi);
    await request(app).post('/api/voice/speak-message').send({ text: 'hello there' });
    expect(mockSpeakingVoiceId).toHaveBeenCalledWith(DEFAULT_VOICE_ID);
    expect(synthesize).toHaveBeenCalledWith(expect.any(String), RYAN);
  });
});

describe('voice routes: GET /api/voice/capabilities', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/voice', voiceRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // The capabilities route filters out per-component-disabled voices; the
    // real prefs reader is mocked, so give it a default (none disabled).
    mockGetDisabledLocalModels.mockResolvedValue(new Set());
  });

  it('returns the engine catalog (piper-only on non-darwin — no Apple dep)', async () => {
    // On a Linux/CI host the engine's listVoices yields piper only. Mock exactly
    // that so this assertion is platform-independent.
    const piperOnly = [
      {
        id: 'en_US-amy-medium',
        engine: 'piper',
        name: 'Amy',
        quality: 'standard',
        lang: 'en-US',
      },
    ];
    mockGetVoiceEngine.mockResolvedValue({
      listVoices: async () => piperOnly,
    } as unknown as VoiceEngineApi);

    const res = await request(app).get('/api/voice/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.voices).toEqual(piperOnly);
    // No Apple voice leaks into a non-darwin catalog.
    expect(res.body.voices.every((v: { engine: string }) => v.engine === 'piper')).toBe(true);
  });

  it('falls back to the piper catalog (never 503s) when no engine is available', async () => {
    mockGetVoiceEngine.mockResolvedValue(null);
    const res = await request(app).get('/api/voice/capabilities');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.voices)).toBe(true);
    expect(res.body.voices.length).toBeGreaterThan(0);
    expect(res.body.voices.every((v: { engine: string }) => v.engine === 'piper')).toBe(true);
  });
});
