/**
 * voiceSession/appleDictation — open-mic DICTATION on Apple's built-in
 * recognizer, with no local voice-detection model (and so no Snaglet voice-model
 * download on macOS).
 *
 * The mic streams continuously into one Apple recognizer session. Each frame's
 * level, plus Apple's own partial text, drives a dictationEndpointer; when it
 * says the utterance is over, FINALIZE makes Apple flush its text, the session
 * sends it as the dictation's voice:final (the client drops it into the
 * composer draft), and the next audio opens the next utterance. Partials show
 * live in between.
 *
 * Why not wait for Apple's own end of phrase: measured on macOS 26, Apple
 * analyzes ~4 s windows and commits a phrase 1-4 s after speech stops, and
 * sometimes not until the input ends. Ending on 1 s of quiet and asking Apple
 * to finalize gets its full, punctuated text ~1 s after the user stops.
 *
 * Frames are processed on one promise chain per session, so a finalize (which
 * waits on the sidecar) never interleaves with the next utterance's audio:
 * frames that arrive meanwhile wait their turn and go to the next utterance.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { createVadFramer } from './openMicVad';
import { createDictationEndpointer, frameRms } from './dictationEndpointer';
import { normalizeTranscript } from './transcriptNormalizer';
import { feedStt, openStt } from './sttIngest';
import { toThread } from './voiceTransport';
import { OPEN_MIC_MAX_PENDING_FRAMES } from './constants';
import type { AppleDictationRuntime, VoiceSessionState } from './types';

/**
 * Stand up Apple-endpointed dictation for a dictate-only open-mic session.
 * `onFailure` is called once if Apple's recognizer stops serving the session;
 * the caller ends the session with the error's plain-language reason.
 */
export function initAppleDictation(
  state: VoiceSessionState,
  onFailure: (err: Error) => void
): void {
  state.appleDictation = {
    endpointer: createDictationEndpointer(),
    framer: createVadFramer(),
    chain: Promise.resolve(),
    pending: 0,
    dropWarned: false,
    failed: false,
    onFailure,
  };
}

/** Queue one captured chunk (native rate for Apple, 16 kHz copy for levels). */
export function feedAppleDictation(
  state: VoiceSessionState,
  native: Int16Array,
  pcm16k: Int16Array
): void {
  const ad = state.appleDictation;
  if (!ad || ad.failed) return;

  // Bound the backlog: a sidecar stuck in finalize (up to its 5 s timeout)
  // must not pile up audio without limit. Past the bound, drop and warn once.
  if (ad.pending >= OPEN_MIC_MAX_PENDING_FRAMES) {
    if (!ad.dropWarned) {
      ad.dropWarned = true;
      LogsService.warn('apple dictation backlog full — dropping audio frames', {
        threadId: state.threadId,
        pending: ad.pending,
      });
    }
    return;
  }

  ad.pending += 1;
  ad.chain = ad.chain
    .then(() => step(state, ad, native, pcm16k))
    .catch((err) => {
      LogsService.warn('apple dictation frame failed', {
        threadId: state.threadId,
        error: getErrorMessage(err),
      });
    })
    .finally(() => {
      ad.pending -= 1;
    });
}

/** True while `ad` is still the live runtime of a session that works. */
function live(state: VoiceSessionState, ad: AppleDictationRuntime): boolean {
  return state.appleDictation === ad && !ad.failed;
}

function fail(state: VoiceSessionState, ad: AppleDictationRuntime, err: Error): void {
  if (!live(state, ad)) return;
  ad.failed = true;
  ad.onFailure(err);
}

async function step(
  state: VoiceSessionState,
  ad: AppleDictationRuntime,
  native: Int16Array,
  pcm16k: Int16Array
): Promise<void> {
  if (!live(state, ad)) return;

  if (!state.stt) {
    // A new utterance: its own key for partials + final, a fresh endpointer.
    state.utteranceSeq += 1;
    ad.endpointer.reset();
    const stt = await openStt(state, (text) => ad.endpointer.noteText(text));
    if (!live(state, ad)) {
      // Stopped while the recognizer opened: don't leave it running.
      stt?.close();
      state.stt = null;
      return;
    }
    stt?.onError?.((err) => fail(state, ad, err));
    if (!live(state, ad)) return; // failed already (the sidecar never came up)
  }

  feedStt(state, native, pcm16k);

  for (const frame of ad.framer.push(pcm16k)) {
    if (ad.endpointer.pushFrame(frameRms(frame))) {
      await endUtterance(state, ad);
      return;
    }
  }
}

/** Finalize the current utterance and hand its text to the composer draft. */
async function endUtterance(state: VoiceSessionState, ad: AppleDictationRuntime): Promise<void> {
  // Pin the ENDING utterance's key — the next audio bumps it.
  const utteranceSeq = state.utteranceSeq;
  const stt = state.stt;
  state.stt = null;
  state.lastPartialAt = 0;
  ad.endpointer.reset();

  let text = '';
  if (stt) {
    try {
      text = (await stt.finalize()).trim();
    } catch (err) {
      LogsService.warn('apple dictation finalize failed', {
        threadId: state.threadId,
        error: getErrorMessage(err),
      });
    } finally {
      try {
        stt.close();
      } catch {
        /* best-effort */
      }
    }
  }

  // Stopped (or failed) while Apple finalized: the client has already let go.
  if (!live(state, ad)) return;

  // Dictation never auto-sends: the text lands in the composer as an editable
  // draft (empty = nothing heard, the client settles nothing).
  toThread(state.threadId, 'voice:final', {
    text: normalizeTranscript(text),
    messageId: null,
    utteranceSeq,
  });
}
