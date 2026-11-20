/**
 * getVoiceEngine — which STT engine a Mac ends up with when Apple's recognizer
 * can't be used, and the reason it carries. The resolvers are mocked at their
 * module seam; VoiceEngineService starts no worker until first use.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockKind = jest.fn<() => 'apple' | 'local'>();
const mockEnsureBinary = jest.fn<() => string | null>();
const mockOsSupported = jest.fn<() => boolean>();

jest.mock('@server/services/voice/sttEngineResolver', () => ({
  resolveSttEngineKind: () => mockKind(),
  ensureAppleSttBinary: () => mockEnsureBinary(),
  appleSpeechOsSupported: () => mockOsSupported(),
  appleSttBinaryPath: () => '/missing/snaglet-apple-stt',
}));
jest.mock('@server/services/voice/ttsEngineResolver', () => ({
  resolveTtsEngineKind: () => 'local',
  ensureAppleTtsBinary: () => null,
  appleTtsBinaryPath: () => '/missing/snaglet-apple-tts',
}));
jest.mock('@server/services/voice/appleSidecarCleanup', () => ({
  sweepAppleSidecarOrphans: () => undefined,
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  __resetVoiceEngine,
  getVoiceEngine,
} from '@server/services/SocketService/voiceSession/engineAdapter';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const forced = process.env.SNAGLET_VOICE_STT_ENGINE;

function onPlatform(name: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: name });
}

describe('getVoiceEngine — local STT fallback on a Mac', () => {
  beforeEach(() => {
    __resetVoiceEngine();
    onPlatform('darwin');
    delete process.env.SNAGLET_VOICE_STT_ENGINE;
    mockKind.mockReset();
    mockEnsureBinary.mockReset();
    mockOsSupported.mockReset().mockReturnValue(true);
  });

  afterAll(() => {
    __resetVoiceEngine();
    if (platform) Object.defineProperty(process, 'platform', platform);
    if (forced === undefined) delete process.env.SNAGLET_VOICE_STT_ENGINE;
    else process.env.SNAGLET_VOICE_STT_ENGINE = forced;
  });

  it('a Mac older than macOS 26 dictates with local STT and says why', async () => {
    mockKind.mockReturnValue('local');
    mockOsSupported.mockReturnValue(false);
    const engine = await getVoiceEngine();
    expect(engine?.sttEngine).toBe('local');
    expect(engine?.prepareStt).toBeUndefined();
    expect(engine?.sttFallbackReason).toBe(
      "Apple's built-in speech recognition needs macOS 26 or later"
    );
  });

  it('an app built without the speech helper dictates with local STT', async () => {
    mockKind.mockReturnValue('local');
    const engine = await getVoiceEngine();
    expect(engine?.sttEngine).toBe('local');
    expect(engine?.sttFallbackReason).toMatch(/Snaglet's speech helper is missing/);
    expect(mockEnsureBinary).not.toHaveBeenCalled();
  });

  it('a helper that cannot be built on demand falls back to local STT', async () => {
    mockKind.mockReturnValue('apple');
    mockEnsureBinary.mockReturnValue(null);
    const engine = await getVoiceEngine();
    expect(engine?.sttEngine).toBe('local');
    expect(engine?.sttFallbackReason).toMatch(/Snaglet's speech helper is missing/);
  });

  it('a bundled helper on macOS 26 gives Apple STT with no fallback reason', async () => {
    mockKind.mockReturnValue('apple');
    mockEnsureBinary.mockReturnValue('/bundle/native/apple-stt/bin/snaglet-apple-stt');
    const engine = await getVoiceEngine();
    expect(engine?.sttEngine).toBe('apple');
    expect(engine?.sttFallbackReason).toBeUndefined();
    await engine?.shutdown?.();
  });

  it('local STT chosen with SNAGLET_VOICE_STT_ENGINE=local, or off macOS, is not a fallback', async () => {
    mockKind.mockReturnValue('local');
    process.env.SNAGLET_VOICE_STT_ENGINE = 'local';
    expect((await getVoiceEngine())?.sttFallbackReason).toBeUndefined();

    __resetVoiceEngine();
    delete process.env.SNAGLET_VOICE_STT_ENGINE;
    onPlatform('linux');
    expect((await getVoiceEngine())?.sttFallbackReason).toBeUndefined();
  });
});
