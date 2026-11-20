/**
 * AppleTtsEngine — driven against the FAKE daemon (tests/support/fake-apple-tts.mjs),
 * a plain node script that speaks the exact wire contract. No Swift, no audio, no
 * AVFoundation — proves the tagged-frame parse, float32→Int16 conversion, ordered
 * per-id streaming, one long-lived process across multiple synths, respawn after
 * the daemon dies, mid-stream abort (barge-in → cancel), listVoices, and a synth
 * error frame surfacing as a thrown iterator.
 *
 * A real-AVSpeechSynthesizer round-trip is gated at the bottom (darwin +
 * SNAGLET_TTS_ENGINE=apple) so CI (Linux, no Apple) skips it.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { AppleTtsEngine } from '@server/services/voice/appleTtsEngine';
import { ensureAppleTtsBinary } from '@server/services/voice/ttsEngineResolver';
import type { TtsChunk } from '@server/services/SocketService/voiceSession/types';

// jest runs from the repo root — resolve the fake daemon there.
const FAKE = join(process.cwd(), 'tests', 'support', 'fake-apple-tts.mjs');

/** Build an engine talking to the fake daemon (node <fake> …). */
function makeEngine(extraArgs: string[] = []) {
  let serveSpawns = 0;
  const spawnSpy = ((cmd: string, args: readonly string[]) => {
    if (args.includes('serve')) serveSpawns++;
    return spawn(cmd, args as string[]);
  }) as unknown as typeof spawn;
  const engine = new AppleTtsEngine({
    command: process.execPath,
    prefixArgs: [FAKE, ...extraArgs],
    spawn: spawnSpy,
    restartBackoffMs: 0,
    listVoicesTimeoutMs: 2_000,
  });
  return { engine, serveSpawns: () => serveSpawns };
}

async function collect(iter: AsyncIterable<TtsChunk>): Promise<TtsChunk[]> {
  const out: TtsChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe('AppleTtsEngine — streaming synthesis', () => {
  it('does not respawn after an intentional shutdown, then re-arms on next use', async () => {
    const { engine, serveSpawns } = makeEngine(['--frames', '1', '--samples', '2']);
    const first = engine.synthesize('first', 'v1');
    await collect(first);
    await engine.shutdown();
    const afterShutdown = serveSpawns();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(serveSpawns()).toBe(afterShutdown);

    expect((await collect(engine.synthesize('second', 'v2'))).length).toBe(1);
    expect(serveSpawns()).toBe(afterShutdown + 1);
    await engine.shutdown();
  });

  it('yields ordered pcm16 frames @ 22050 and ends', async () => {
    const { engine } = makeEngine(['--frames', '3', '--samples', '4']);
    const chunks = await collect(engine.synthesize('hello', 'apple-voice'));
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.sampleRate).toBe(22_050);
      expect(c.pcm16).toBeInstanceOf(Int16Array);
      expect(c.pcm16.length).toBe(4);
    }
    await engine.shutdown();
  });

  it('converts the daemon float32 payload to Int16 via f32ToI16 (clamped)', async () => {
    // The fake emits one frame with these exact float32 values.
    const { engine } = makeEngine(['--floats', '0.5,-0.5,1,-1,0']);
    const chunks = await collect(engine.synthesize('x', 'apple-voice'));
    expect(chunks.length).toBe(1);
    // 0.5→round(0.5*32767)=16384; -0.5→-0.5*32768=-16384; 1→32767; -1→-32768; 0→0
    expect(Array.from(chunks[0]!.pcm16)).toEqual([16384, -16384, 32767, -32768, 0]);
    await engine.shutdown();
  });

  it('runs multiple synths over one long-lived process', async () => {
    const { engine, serveSpawns } = makeEngine(['--frames', '2', '--samples', '2']);
    expect((await collect(engine.synthesize('a', 'v1'))).length).toBe(2);
    expect((await collect(engine.synthesize('b', 'v2'))).length).toBe(2);
    expect(serveSpawns()).toBe(1); // same daemon reused, not respawned
    await engine.shutdown();
  });

  it('respawns after the daemon process dies', async () => {
    const { engine, serveSpawns } = makeEngine([
      '--frames',
      '2',
      '--samples',
      '2',
      '--exit-after-synth',
    ]);
    expect((await collect(engine.synthesize('a', 'v1'))).length).toBe(2);
    // The fake exits ~30 ms after END — wait for the exit to register.
    await new Promise((r) => setTimeout(r, 80));
    expect((await collect(engine.synthesize('b', 'v2'))).length).toBe(2);
    expect(serveSpawns()).toBe(2); // fresh process after the crash
    await engine.shutdown();
  });

  it('aborting the iterator mid-stream (barge-in) cancels without hanging', async () => {
    const { engine, serveSpawns } = makeEngine([
      '--frames',
      '20',
      '--samples',
      '2',
      '--frame-delay-ms',
      '15',
    ]);
    let seen = 0;
    for await (const _chunk of engine.synthesize('long', 'v1')) {
      seen += 1;
      if (seen === 1) break; // abandon after the first frame → engine sends cancel
    }
    expect(seen).toBe(1);
    // The daemon survives the cancel and serves a fresh synth on the same process.
    const next = await collect(engine.synthesize('again', 'v2'));
    expect(next.length).toBe(20);
    expect(serveSpawns()).toBe(1);
    await engine.shutdown();
  });

  it('surfaces a daemon error frame as a thrown iterator', async () => {
    const { engine } = makeEngine(['--error-voice', 'broken']);
    await expect(collect(engine.synthesize('x', 'broken'))).rejects.toThrow(/unknown voice/);
    await engine.shutdown();
  });
});

describe('AppleTtsEngine — listVoices', () => {
  it('parses the daemon voice list with quality tiers + langs', async () => {
    const { engine } = makeEngine();
    const voices = await engine.listVoices();
    expect(voices.length).toBe(3);
    expect(voices.map((v) => v.quality).sort()).toEqual(['default', 'enhanced', 'premium']);
    const premium = voices.find((v) => v.quality === 'premium');
    expect(premium?.identifier).toBe('com.apple.voice.premium.en-US.Zoe');
    expect(premium?.lang).toBe('en-US');
    await engine.shutdown();
  });
});

// Real AVSpeechSynthesizer round-trip (opt-in)
// `describe.skipIf` is not a jest API, so gate with a conditional describe:
// runs only on darwin with SNAGLET_TTS_ENGINE=apple (mirrors SNAGLET_VOICE_STT_ENGINE);
// CI (Linux) always skips it — no Apple dependency in the green suite.
const runReal = process.platform === 'darwin' && process.env.SNAGLET_TTS_ENGINE === 'apple';
const describeReal = runReal ? describe : describe.skip;

describeReal('AppleTtsEngine — real AVSpeechSynthesizer', () => {
  it('lists installed voices and renders real audio through the built sidecar', async () => {
    const bin = ensureAppleTtsBinary();
    expect(bin).toBeTruthy();
    const engine = new AppleTtsEngine({ command: bin! });
    try {
      const voices = await engine.listVoices();
      expect(voices.length).toBeGreaterThan(0);
      let samples = 0;
      for await (const chunk of engine.synthesize('Hello from Snaglet.', voices[0]!.identifier)) {
        expect(chunk.sampleRate).toBe(22_050);
        samples += chunk.pcm16.length;
      }
      expect(samples).toBeGreaterThan(0);
    } finally {
      await engine.shutdown();
    }
  }, 30_000);
});
