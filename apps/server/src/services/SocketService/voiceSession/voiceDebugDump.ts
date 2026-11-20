/**
 * voiceDebugDump — capture-path audit tooling.
 *
 * When `SNAGLET_VOICE_DEBUG_DUMP=1`, every finalized utterance's retained pcm16 is
 * written to `~/.snaglet/voice-debug/<timestamp>-<sessionId>.wav` (16 kHz mono) and
 * its shape is logged: duration, peak amplitude, RMS, and clipping ratio. This
 * shows exactly what the browser capture chain delivered
 * to the server during a live test — so a bad transcript can be blamed on the
 * capture (resample / AEC mangling / clipping) or exonerated, before blaming the
 * model.
 *
 * Off by default and zero-cost when off: the env flag is read once at module
 * load, and `dumpUtteranceIfEnabled` early-returns before touching the filesystem
 * or computing any statistics.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getErrorMessage } from '@snaglet/shared/utils';
import { expandHomePath } from '@snaglet/shared/utils/paths';
import { LogsService } from '@server/services/LogsService';
import { VOICE_SAMPLE_RATE } from './constants';

/** Read once — the whole dump path compiles out to an early return when unset. */
const DUMP_ENABLED = process.env.SNAGLET_VOICE_DEBUG_DUMP === '1';

export function isVoiceDebugDumpEnabled(): boolean {
  return DUMP_ENABLED;
}

/** Minimal canonical 16-bit PCM mono WAV (44-byte header + samples). */
function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataLen = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(1, 22); // channels = mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

export interface CaptureStats {
  readonly durationMs: number;
  /** Peak amplitude in [0, 1] (max |sample| / 32768). */
  readonly peak: number;
  /** RMS level in [0, 1]. */
  readonly rms: number;
  /** Fraction of samples at full-scale (a clipping proxy). */
  readonly clippingRatio: number;
}

/** Peak / RMS / clipping over pcm16 samples (exported for tests). */
export function computeCaptureStats(pcm: Int16Array, sampleRate: number): CaptureStats {
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i];
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    sumSq += s * s;
    if (a >= 32767) clipped++;
  }
  const n = pcm.length || 1;
  return {
    durationMs: Math.round((pcm.length / sampleRate) * 1000),
    peak: Number((peak / 32768).toFixed(4)),
    rms: Number((Math.sqrt(sumSq / n) / 32768).toFixed(4)),
    clippingRatio: Number((clipped / n).toFixed(4)),
  };
}

/**
 * Dump a finalized utterance's pcm to a wav + log its capture stats — but only
 * when `SNAGLET_VOICE_DEBUG_DUMP=1`. No-op (and no cost) otherwise. Best-effort: an IO
 * failure is logged and swallowed so the audit never breaks the voice path.
 */
export function dumpUtteranceIfEnabled(
  sessionId: string,
  pcm: Int16Array,
  sampleRate: number = VOICE_SAMPLE_RATE
): void {
  if (!DUMP_ENABLED || pcm.length === 0) return;
  try {
    // `~`-expanded like every SNAGLET_HOME read; the boot-time resolvers already
    // reject relative values, so no strict validation is repeated here.
    const configuredHome = process.env.SNAGLET_HOME?.trim();
    const snagletHome = configuredHome
      ? expandHomePath(configuredHome)
      : path.join(homedir(), '.snaglet');
    const dir = path.join(snagletHome, 'temp', 'voice-debug');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '') || 'session';
    const file = path.join(dir, `${stamp}-${safeSession}.wav`);
    writeFileSync(file, encodeWav(pcm, sampleRate));
    const stats = computeCaptureStats(pcm, sampleRate);
    LogsService.info('voice:capture:audit', {
      file,
      sampleRate,
      samples: pcm.length,
      durationMs: stats.durationMs,
      peak: stats.peak,
      rms: stats.rms,
      clippingRatio: stats.clippingRatio,
    });
  } catch (err) {
    LogsService.warn('voice:capture:audit dump failed', { error: getErrorMessage(err) });
  }
}
