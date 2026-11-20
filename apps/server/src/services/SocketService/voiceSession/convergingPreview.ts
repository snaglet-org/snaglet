/**
 * voiceSession/convergingPreview — periodic quality re-decode of the live
 * utterance, as free functions over a VoiceSessionState. On each cadence tick, if an utterance is active and
 * no decode is already in flight, re-decode the accumulated pcm with the quality
 * tier and emit a converging tier:'quality' voice:partial. Fully guarded +
 * best-effort — a failure never disturbs the streaming partials or the final.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { getVoiceEngine } from './engineAdapter';
import { normalizeTranscript } from './transcriptNormalizer';
import { isUtteranceActive, peekUtterancePcm } from './sttIngest';
import { toThread } from './voiceTransport';
import { PREVIEW_DECODE_MAX_SAMPLES } from './constants';
import type { VoiceSessionState } from './types';

/**
 * One cadence tick: if an utterance is active and no decode is already in
 * flight (preview OR final), re-decode the accumulated pcm with the quality
 * tier and emit a converging tier:'quality' preview. Fully guarded + best-
 * effort — a failure never disturbs the streaming partials or the final.
 */
export function runPreviewDecode(state: VoiceSessionState): void {
  if (!isUtteranceActive(state)) return; // no utterance → zero cost
  if (state.previewDecodeInFlight || state.finalDecodeInFlight) return; // one at a time
  const pcm = peekUtterancePcm(state, PREVIEW_DECODE_MAX_SAMPLES);
  if (pcm.length === 0) return;
  state.previewDecodeInFlight = true;
  void decodePreview(state, pcm).finally(() => {
    state.previewDecodeInFlight = false;
  });
}

async function decodePreview(state: VoiceSessionState, pcm: Int16Array): Promise<void> {
  // The utterance this preview was captured for — pinned before the async decode
  // so a preview that resolves after the utterance has ended (and a new one has
  // begun) can be dropped instead of bleeding onto the next utterance.
  const seq = state.utteranceSeq;
  const engine = await getVoiceEngine();
  const qualityDecode = engine?.qualityDecode?.bind(engine) as
    | ((p: Int16Array) => Promise<string>)
    | undefined;
  if (!qualityDecode) return; // engine has no quality tier → streaming only
  let raw = '';
  try {
    raw = await qualityDecode(pcm);
  } catch (err) {
    LogsService.warn('voice preview re-decode failed', {
      threadId: state.threadId,
      error: getErrorMessage(err),
    });
    return;
  }
  // Drop a stale preview: the utterance may have finalized while the worker
  // decoded (no utterance active) or a new utterance may have begun since
  // (utteranceSeq advanced) — either way this text belongs to a settled/
  // superseded utterance and must never land on top of the current one.
  if (!isUtteranceActive(state) || state.utteranceSeq !== seq) return;
  const text = normalizeTranscript(raw);
  if (text.length === 0) return;
  toThread(state.threadId, 'voice:partial', { text, tier: 'quality', utteranceSeq: seq });
}
