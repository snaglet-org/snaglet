/**
 * voice-smoke — end-to-end proof that the local voice engine actually works:
 * wav -> text (streaming STT) and text -> wav (piper TTS), plus a silero VAD
 * speech-vs-silence check. Not a jest test — it loads the real models and
 * (on macOS) generates its own input wav with `say`, so it needs the fetched
 * models and audio tooling. CI never runs this; run it by hand:
 *
 *   pnpm --filter @snaglet/server voice:fetch   # once, to download the models
 *   pnpm --filter @snaglet/server voice:smoke
 *
 * It prints real transcription output and synthesis timings.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { VoiceEngineService } from '../services/voice/VoiceEngineService';
import {
  DEFAULT_VOICE_ID,
  espeakDataDir,
  sttModelPaths,
  vadModelPath,
  voiceModelPaths,
} from '../services/voice/voiceModelManifest';

const REFERENCE = 'the quick brown fox jumps over the lazy dog';

function ms(from: number): string {
  return `${(Date.now() - from).toFixed(0)}ms`;
}

function requireModels(): void {
  const stt = sttModelPaths();
  const missing = [
    stt.encoder,
    stt.tokens,
    vadModelPath(),
    voiceModelPaths(DEFAULT_VOICE_ID).model,
    path.join(espeakDataDir(), 'phontab'),
  ].filter((p) => !existsSync(p));
  if (missing.length) {
    console.error(
      '[voice-smoke] missing model files — run `pnpm --filter @snaglet/server voice:fetch` first:'
    );
    for (const m of missing) console.error('  - ' + m);
    process.exit(1);
  }
}

/** Generate a 16 kHz mono pcm16 wav of `text` via macOS `say`. */
function sayToWav(text: string, out: string): boolean {
  const r = spawnSync('say', ['--data-format=LEI16@16000', '--file-format=WAVE', '-o', out, text], {
    stdio: 'ignore',
  });
  return r.status === 0 && existsSync(out);
}

async function main(): Promise<void> {
  requireModels();
  const work = await mkdtemp(path.join(tmpdir(), 'snaglet-voice-smoke-'));
  const inputWav = path.join(work, 'input.wav');
  const outWav = path.join(work, 'tts.wav');

  console.log('=== Snaglet voice engine smoke ===');
  console.log(`sherpa-onnx-node ${sherpa.version}\n`);

  if (!sayToWav(REFERENCE, inputWav)) {
    console.error('[voice-smoke] `say` failed — this proof needs macOS. Aborting.');
    process.exit(1);
  }
  const wav = sherpa.readWave(inputWav) as { samples: Float32Array; sampleRate: number };
  console.log(
    `input.wav: ${wav.samples.length} samples @ ${wav.sampleRate}Hz ` +
      `(${(wav.samples.length / wav.sampleRate).toFixed(2)}s), reference="${REFERENCE}"\n`
  );

  const pcm16 = new Int16Array(wav.samples.length);
  for (let i = 0; i < wav.samples.length; i++) {
    const v = Math.max(-1, Math.min(1, wav.samples[i]));
    pcm16[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }

  const svc = new VoiceEngineService();
  try {
    // warmup (kills cold-start from the first real call)
    const wT = Date.now();
    await svc.warmup(DEFAULT_VOICE_ID);
    console.log(`warmup (load STT+TTS+VAD): ${ms(wT)}\n`);

    // STT: stream the wav in 100ms chunks
    const stt = await svc.createSttSession();
    const chunk = 1600; // 100ms @16k
    let lastPartial = '';
    const sT = Date.now();
    for (let i = 0; i < pcm16.length; i += chunk) {
      lastPartial = await stt.feed(pcm16.subarray(i, i + chunk));
    }
    const feedMs = ms(sT);
    const fT = Date.now();
    const finalText = await stt.finalize();
    const finalizeMs = ms(fT);
    const hit = finalText
      .toLowerCase()
      .replace(/[^a-z ]/g, '')
      .includes(REFERENCE);
    console.log('--- STT (wav -> text) ---');
    console.log(`last partial: "${lastPartial}"`);
    console.log(`final:        "${finalText}"`);
    console.log(`match reference: ${hit ? 'YES' : 'NO'}`);
    console.log(`feed(stream) ${feedMs} · finalize ${finalizeMs}\n`);

    // TTS: synth a sentence, time first-chunk + total
    const ttsText = 'Sure, I can help with that. One second while I check.';
    const chunks: Int16Array[] = [];
    let firstChunkAt = 0;
    let sampleRate = 0;
    const tT = Date.now();
    const { sampleRate: sr } = await svc.synthesize(ttsText, DEFAULT_VOICE_ID, (c) => {
      if (!firstChunkAt) firstChunkAt = Date.now();
      sampleRate = c.sampleRate;
      chunks.push(c.pcm16);
    });
    const totalMs = ms(tT);
    const firstMs = firstChunkAt ? `${firstChunkAt - tT}ms` : 'n/a';
    const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
    // assemble + persist a wav as the artifact
    const all = new Float32Array(totalSamples);
    let off = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) all[off++] = c[i] / 32768;
    }
    sherpa.writeWave(outWav, { samples: all, sampleRate: sr });
    console.log('--- TTS (text -> wav) ---');
    console.log(`text: "${ttsText}"`);
    console.log(
      `${chunks.length} chunks, ${totalSamples} samples @ ${sampleRate || sr}Hz ` +
        `(${(totalSamples / (sampleRate || sr)).toFixed(2)}s audio)`
    );
    console.log(`first chunk ${firstMs} · total ${totalMs}`);
    console.log(`wav written: ${outWav}  (play with: afplay ${outWav})\n`);

    // VAD: speech frames vs silence frames
    const speechSid = await svc.createVadSession();
    const speechProbs: number[] = [];
    const f = new Float32Array(512);
    for (let i = 0; i + 512 <= wav.samples.length; i += 512) {
      f.set(wav.samples.subarray(i, i + 512));
      speechProbs.push(await svc.vadProbability(f, speechSid));
    }
    const silenceSid = await svc.createVadSession();
    const silenceProbs: number[] = [];
    const zero = new Float32Array(512);
    for (let i = 0; i < 40; i++) silenceProbs.push(await svc.vadProbability(zero, silenceSid));
    const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(3);
    const max = (a: number[]) => Math.max(...a).toFixed(3);
    console.log('--- VAD (silero v5, [1,576]) ---');
    console.log(
      `speech frames=${speechProbs.length} avg=${avg(speechProbs)} max=${max(speechProbs)} ` +
        `>0.5=${speechProbs.filter((p) => p > 0.5).length}`
    );
    console.log(
      `silence frames=${silenceProbs.length} avg=${avg(silenceProbs)} max=${max(silenceProbs)}\n`
    );

    console.log('=== smoke complete ===');
  } finally {
    await svc.shutdown();
  }
}

main().catch((err) => {
  console.error('[voice-smoke] failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
