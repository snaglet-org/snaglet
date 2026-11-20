/**
 * buildTtsRouter — the hybrid-TTS dispatch seam. With mocked sub-engines (no
 * worker, no sidecar) it proves: `apple:*` → the Apple sub-engine (prefix
 * stripped), `piper:*`/bare → the base (piper) engine, the back-compat invariant
 * (a bare stored voice still hits piper), and that listVoices merges the piper
 * catalog with namespaced Apple voices.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { describe, expect, it, jest } from '@jest/globals';
import { buildTtsRouter } from '@server/services/SocketService/voiceSession/engineAdapter';
import type {
  TtsChunk,
  VoiceEngineApi,
  VoiceInfo,
} from '@server/services/SocketService/voiceSession/types';
import type { AppleTtsEngine } from '@server/services/voice/appleTtsEngine';
import { DEFAULT_VOICE_ID } from '@server/services/SocketService/voiceSession/constants';

/** A one-frame async iterable tagged with `marker` so we can tell engines apart. */
function oneFrame(marker: number): AsyncGenerator<TtsChunk> {
  return (async function* () {
    yield { pcm16: Int16Array.from([marker]), sampleRate: 22_050 };
  })();
}

async function firstMarker(iter: AsyncIterable<TtsChunk>): Promise<number> {
  for await (const c of iter) return c.pcm16[0]!;
  throw new Error('no frames');
}

const PIPER_MARKER = 100;
const APPLE_MARKER = 777;

function makeRouter() {
  const baseSynth = jest.fn((_text: string, _voiceId: string) => oneFrame(PIPER_MARKER));
  const base = {
    createSttSession: () => {
      throw new Error('unused');
    },
    synthesize: baseSynth,
    async listVoices(): Promise<VoiceInfo[]> {
      return [
        {
          id: 'en_US-amy-medium',
          engine: 'piper',
          name: 'Amy',
          quality: 'standard',
          lang: 'en-US',
        },
      ];
    },
    async warmup(): Promise<void> {},
  } as unknown as VoiceEngineApi;

  const appleSynth = jest.fn((_text: string, _voiceId: string) => oneFrame(APPLE_MARKER));
  const apple = {
    synthesize: appleSynth,
    async listVoices() {
      return [
        {
          identifier: 'com.apple.voice.premium.en-US.Zoe',
          name: 'Zoe',
          quality: 'premium' as const,
          lang: 'en-US',
        },
      ];
    },
    async warmup(): Promise<void> {},
  } as unknown as AppleTtsEngine;

  return { router: buildTtsRouter(base, apple), baseSynth, appleSynth };
}

describe('buildTtsRouter — synthesize dispatch by namespace', () => {
  it('apple:<id> → the Apple sub-engine, with the prefix stripped', async () => {
    const { router, baseSynth, appleSynth } = makeRouter();
    const marker = await firstMarker(
      router.synthesize('hi', 'apple:com.apple.voice.premium.en-US.Zoe')
    );
    expect(marker).toBe(APPLE_MARKER);
    expect(appleSynth).toHaveBeenCalledWith('hi', 'com.apple.voice.premium.en-US.Zoe');
    expect(baseSynth).not.toHaveBeenCalled();
  });

  it('piper:<id> → the base engine, with the prefix stripped', async () => {
    const { router, baseSynth, appleSynth } = makeRouter();
    const marker = await firstMarker(router.synthesize('hi', 'piper:en_US-ryan-medium'));
    expect(marker).toBe(PIPER_MARKER);
    expect(baseSynth).toHaveBeenCalledWith('hi', 'en_US-ryan-medium');
    expect(appleSynth).not.toHaveBeenCalled();
  });

  it('a bare (unprefixed) voice id → piper, unchanged', async () => {
    const { router, baseSynth, appleSynth } = makeRouter();
    const marker = await firstMarker(router.synthesize('hi', 'en_US-amy-medium'));
    expect(marker).toBe(PIPER_MARKER);
    expect(baseSynth).toHaveBeenCalledWith('hi', 'en_US-amy-medium');
    expect(appleSynth).not.toHaveBeenCalled();
  });

  it('the default voice id → piper', async () => {
    const { router, baseSynth, appleSynth } = makeRouter();
    const marker = await firstMarker(router.synthesize('hi', DEFAULT_VOICE_ID));
    expect(marker).toBe(PIPER_MARKER);
    expect(baseSynth).toHaveBeenCalledWith('hi', DEFAULT_VOICE_ID);
    expect(appleSynth).not.toHaveBeenCalled();
  });
});

describe('buildTtsRouter — listVoices merge', () => {
  it('merges the piper catalog (bare ids) with namespaced Apple voices', async () => {
    const { router } = makeRouter();
    const voices = await router.listVoices!();
    const ids = voices.map((v) => v.id);
    expect(ids).toContain('en_US-amy-medium'); // piper stays bare (back-compat)
    expect(ids).toContain('apple:com.apple.voice.premium.en-US.Zoe'); // apple namespaced

    const apple = voices.find((v) => v.engine === 'apple');
    expect(apple?.quality).toBe('premium');
    expect(apple?.lang).toBe('en-US');
    const piper = voices.find((v) => v.engine === 'piper');
    expect(piper?.quality).toBe('standard');
  });
});
