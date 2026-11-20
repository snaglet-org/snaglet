/**
 * voiceSession/sttIngest — inbound-audio buffering + STT session I/O.
 *
 * Free functions over a VoiceSessionState: capture-rate band-limiting, the STT session
 * open/feed + throttled voice:partial emission, the retained-utterance pcm
 * buffer (retain / reset / consume / peek), and the two-tier final resolve.
 *
 * The partial-throttle timestamp is a field on the VoiceSessionState
 * (state.lastPartialAt) — one session per client, so it lives with the state.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { logger } from '@server/config/logger';
import { createDecimator } from '@server/services/voice/decimator';
import { getVoiceEngine } from './engineAdapter';
import { normalizeTranscript } from './transcriptNormalizer';
import { resolveTwoTierFinal, type TwoTierFinal } from './twoTierStt';
import { voiceError, toThread } from './voiceTransport';
import {
  PARTIAL_THROTTLE_MS,
  VOICE_SAMPLE_RATE,
  QUALITY_DECODE_TIMEOUT_MS,
  QUALITY_DECODE_MAX_SAMPLES,
} from './constants';
import type { SttSession, VoiceSessionState, VoiceAudioChunkPayload } from './types';

// Capture-rate band-limiting

/** Read the client's native capture rate from a chunk (default 16 kHz). */
export function readCaptureRate(payload: VoiceAudioChunkPayload): number {
  const r = Number((payload as { sampleRate?: number }).sampleRate);
  return Number.isFinite(r) && r > 0 ? Math.round(r) : VOICE_SAMPLE_RATE;
}

/** Band-limit native-rate pcm down to 16 kHz (identity when already 16 kHz). */
export function bandLimitTo16k(state: VoiceSessionState, native: Int16Array): Int16Array {
  const rate = state.captureSampleRate;
  if (rate <= VOICE_SAMPLE_RATE) return native; // already 16k (or lower — no upsample)
  if (!state.decimator || state.decimator.inRate !== rate) {
    state.decimator = createDecimator(rate, VOICE_SAMPLE_RATE);
  }
  return state.decimator.process(native);
}

// STT session I/O

/** Feed the active STT session — native pcm for Apple, 16 kHz for local. */
export function feedStt(state: VoiceSessionState, native: Int16Array, pcm16k: Int16Array): void {
  const stt = state.stt;
  if (!stt) return;
  try {
    stt.feed(state.sttWantsNativeRate ? native : pcm16k);
  } catch (err) {
    LogsService.warn('voice audio feed failed', {
      threadId: state.threadId,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Open the STT session for the next utterance and wire its partials to the
 * client; resolves the session (null: no engine). `onText` also sees every
 * partial (Apple dictation's endpointer uses it to know words were heard) —
 * the engine takes one partial listener only.
 */
export async function openStt(
  state: VoiceSessionState,
  onText?: (text: string) => void
): Promise<SttSession | null> {
  if (state.stt) return state.stt;
  const engine = await getVoiceEngine();
  if (!engine) {
    voiceError(state.threadId, 'voice engine unavailable', false);
    return null;
  }
  const stt = engine.createSttSession({ sampleRate: state.captureSampleRate });
  stt.onPartial((text) => {
    emitPartial(state, text);
    onText?.(text);
  });
  state.stt = stt;
  state.sttWantsNativeRate = stt.wantsNativeRate ?? false;
  return stt;
}

function emitPartial(state: VoiceSessionState, text: string): void {
  const now = Date.now();
  // Throttle only the local engine's per-chunk 'live' stream. Apple ('quality'
  // tier) reports a few bursts per utterance, each a run of word-by-word lines
  // within a millisecond: throttling kept only the first (stale) line of each
  // burst on screen until the next one, seconds later.
  if (state.partialTier === 'live' && now - state.lastPartialAt < PARTIAL_THROTTLE_MS) return;
  state.lastPartialAt = now;
  // Normalize the streaming partial (the local zipformer's ALL-CAPS output →
  // sentence case; Apple's already-cased text passes through untouched) and tag
  // it with the engine's tier: local → 'live' (the periodic quality re-decode
  // upgrades it to 'quality'); Apple → 'quality' (its partials ARE the quality
  // tier — cased, punctuated, phrase-gated). The per-utterance key lets the
  // client reset its converging preview across the boundary.
  toThread(state.threadId, 'voice:partial', {
    text: normalizeTranscript(text),
    tier: state.partialTier,
    utteranceSeq: state.utteranceSeq,
  });
}

// Converging preview support: is an utterance active?

/** True while an utterance is being captured (PTT stt open / open-mic speech). */
export function isUtteranceActive(state: VoiceSessionState): boolean {
  if (state.mode === 'open') return state.openMic?.inSpeech === true;
  return state.stt !== null;
}

// Two-tier STT: retain the utterance pcm, resolve the dispatched final

/** Append a pcm16 chunk to the utterance buffer (capped). */
export function retainPcm(state: VoiceSessionState, pcm16: Int16Array): void {
  if (state.utterancePcmSamples >= QUALITY_DECODE_MAX_SAMPLES) return;
  state.utterancePcm.push(pcm16);
  state.utterancePcmSamples += pcm16.length;
}

/** Reset the utterance pcm buffer (start of a new utterance). */
export function resetPcm(state: VoiceSessionState): void {
  state.utterancePcm = [];
  state.utterancePcmSamples = 0;
}

/** Merge + clear the retained utterance pcm into one contiguous Int16Array. */
export function consumeUtterancePcm(state: VoiceSessionState): Int16Array {
  const merged = new Int16Array(state.utterancePcmSamples);
  let offset = 0;
  for (const chunk of state.utterancePcm) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  resetPcm(state);
  return merged;
}

/**
 * Copy (WITHOUT consuming) the last `maxSamples` of the retained utterance pcm
 * into one contiguous Int16Array — the input to a preview re-decode. Long
 * dictation only ever re-decodes the recent tail; the buffer is left intact so
 * the FINAL decode still sees the whole utterance.
 */
export function peekUtterancePcm(state: VoiceSessionState, maxSamples: number): Int16Array {
  const total = state.utterancePcmSamples;
  if (total === 0) return new Int16Array(0);
  const take = Math.min(total, maxSamples);
  const out = new Int16Array(take);
  let skip = total - take; // drop the oldest samples beyond the cap
  let offset = 0;
  for (const chunk of state.utterancePcm) {
    let c = chunk;
    if (skip > 0) {
      if (skip >= c.length) {
        skip -= c.length;
        continue;
      }
      c = c.subarray(skip);
      skip = 0;
    }
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Resolve the dispatched final from both tiers: race the offline Moonshine
 * re-decode of `pcm` against the timeout, else fall back to the normalized
 * streaming final. Logs the winning tier + real decode latency.
 */
export async function resolveFinal(
  state: VoiceSessionState,
  streamingText: string,
  pcm: Int16Array
): Promise<TwoTierFinal> {
  // Mark the FINAL decode in flight so the preview cadence stands down — the
  // two must never contend on the same utterance's pcm.
  state.finalDecodeInFlight = true;
  try {
    const engine = await getVoiceEngine();
    const qualityDecode = engine?.qualityDecode?.bind(engine) as
      | ((p: Int16Array) => Promise<string>)
      | undefined;
    const resolved = await resolveTwoTierFinal({
      streamingText,
      pcm,
      qualityDecode,
      timeoutMs: QUALITY_DECODE_TIMEOUT_MS,
    });
    logger.info(
      `[voice] two-tier final [tier=${resolved.tier}] [qualityMs=${resolved.qualityDecodeMs}]` +
        `${resolved.timedOut ? ' [timedOut]' : ''} [thread=${state.threadId}]`
    );
    return resolved;
  } finally {
    state.finalDecodeInFlight = false;
  }
}
