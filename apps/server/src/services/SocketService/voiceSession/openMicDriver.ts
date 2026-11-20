/**
 * voiceSession/openMicDriver — open-mic (mode 'open') server-side VAD
 * endpointing, as free functions over a VoiceSessionState. The VAD owns
 * finalize in open mode: it serializes frame processing per session, endpoints
 * on silence, and dispatches off the VAD chain so frame processing never stalls
 * behind the quality re-decode + send.
 *
 * The partial-throttle timestamp (state.lastPartialAt) is reset to 0 here at
 * speech-end.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { logger } from '@server/config/logger';
import { abortThread } from '@server/services/SocketService/abortStore';
import { clearFloorForBargeIn, currentFloorHolder, currentFloorUtteranceId } from './floorArbiter';
import { isToolInFlight } from './runPhaseTracker';
import { decideBargeInAction } from './bargeIn';
import { createVadEndpointer, createVadFramer, isBackchannelUtterance } from './openMicVad';
import { dumpUtteranceIfEnabled } from './voiceDebugDump';
import { toThread, voiceError } from './voiceTransport';
import {
  openStt,
  feedStt,
  retainPcm,
  resetPcm,
  consumeUtterancePcm,
  resolveFinal,
} from './sttIngest';
import { sendTranscript } from './voiceDispatch';
import {
  OPEN_MIC_SILENCE_MS,
  OPEN_MIC_BARGEIN_SILENCE_MS,
  OPEN_MIC_MIN_SPEECH_MS,
  OPEN_MIC_MAX_PENDING_FRAMES,
  OPEN_MIC_PREROLL_CHUNKS,
  VAD_FRAME_SAMPLES,
} from './constants';
import type { VoiceSessionState, OpenMicRuntime, BargeInTarget, VoiceEngineApi } from './types';

/**
 * Stand up the open-mic VAD endpointing runtime for a session. Open mic ends an
 * utterance only when the VAD hears silence, so without it nothing is ever
 * transcribed: this rejects (with the engine's reason) and the caller refuses
 * the session. The silent probe frame loads the VAD model now — otherwise it
 * loads on the first real frame, where a missing model fails every frame out
 * of the user's sight.
 */
export async function initOpenMic(state: VoiceSessionState, engine: VoiceEngineApi): Promise<void> {
  if (!engine.createVadSession) {
    throw new Error('this voice engine has no voice detection');
  }
  const vad = await engine.createVadSession();
  try {
    await vad.process(new Float32Array(VAD_FRAME_SAMPLES));
  } catch (err) {
    void vad.close().catch((closeErr) => {
      logger.debug(`[voice] VAD close after failed probe: ${getErrorMessage(closeErr)}`);
    });
    throw err;
  }
  state.openMic = {
    vad,
    endpointer: createVadEndpointer({
      silenceMs: OPEN_MIC_SILENCE_MS,
      minSpeechMs: OPEN_MIC_MIN_SPEECH_MS,
    }),
    framer: createVadFramer(),
    chain: Promise.resolve(),
    dispatchChain: Promise.resolve(),
    pending: 0,
    droppedFrames: 0,
    dropWarned: false,
    frameErrorReported: false,
    preRoll: [],
    inSpeech: false,
    tentativeBargeIn: null,
  };
}

/**
 * Serialize open-mic frame processing per session (VAD is async — frames must
 * stay in order). Each chunk: run silero VAD over its 512-sample frames, drive
 * the endpointer, and feed audio to STT while inside a speech run.
 */
export function feedOpenMic(
  state: VoiceSessionState,
  clientId: string,
  native: Int16Array,
  pcm16k: Int16Array
): void {
  const om = state.openMic;
  if (!om) return;

  // Bound the chain: if VAD can't keep pace with realtime audio, links —
  // each retaining a pcm16 buffer — pile up without limit. Past the bound, drop
  // the incoming frame (do not enqueue) and warn once so a slow VAD degrades
  // gracefully instead of leaking memory.
  if (om.pending >= OPEN_MIC_MAX_PENDING_FRAMES) {
    om.droppedFrames += 1;
    if (!om.dropWarned) {
      om.dropWarned = true;
      LogsService.warn('open-mic VAD overloaded — dropping audio frames', {
        threadId: state.threadId,
        pending: om.pending,
      });
    }
    return;
  }

  om.pending += 1;
  om.chain = om.chain
    .then(() => feedOpenMicAsync(state, clientId, om, native, pcm16k))
    .catch((err) => {
      LogsService.warn('open-mic frame processing failed', {
        threadId: state.threadId,
        error: getErrorMessage(err),
      });
      // Tell the user once: a failing frame means their speech is being lost.
      if (!om.frameErrorReported) {
        om.frameErrorReported = true;
        voiceError(
          state.threadId,
          `Voice input stopped working: ${getErrorMessage(err)}. Turn voice off and on to retry.`,
          false
        );
      }
    })
    .finally(() => {
      om.pending -= 1;
    });
}

async function feedOpenMicAsync(
  state: VoiceSessionState,
  clientId: string,
  om: OpenMicRuntime,
  native: Int16Array,
  pcm16k: Int16Array
): Promise<void> {
  // Keep a short pre-roll so the first word (which precedes VAD onset) isn't
  // clipped — fed to STT when speech starts. Hold both rates so the flush can
  // feed whichever the active engine wants.
  om.preRoll.push({ native, pcm16k });
  if (om.preRoll.length > OPEN_MIC_PREROLL_CHUNKS) om.preRoll.shift();

  // The silero VAD framer + endpointer always run at 16 kHz.
  const frames = om.framer.push(pcm16k);
  for (const frame of frames) {
    const prob = await om.vad.process(frame);
    for (const evt of om.endpointer.push(prob)) {
      if (evt.type === 'speech-start') {
        await onOpenMicSpeechStart(state);
      } else {
        // Pass voicedMs — the backchannel decision is transcript-aware and
        // made in onOpenMicSpeechEnd (after finalize), not from duration alone.
        await onOpenMicSpeechEnd(state, clientId, evt.voicedMs);
        return; // utterance closed; remaining frames belong to the next one
      }
    }
  }

  // While speaking, stream this chunk's audio into the recognizer and retain
  // the 16 kHz copy for the two-tier quality re-decode + capture audit.
  if (om.inSpeech) {
    retainPcm(state, pcm16k);
    feedStt(state, native, pcm16k);
  }
}

async function onOpenMicSpeechStart(state: VoiceSessionState): Promise<void> {
  const om = state.openMic;
  if (!om) return;
  om.inSpeech = true;

  // A new open-mic utterance begins — bump the per-utterance key so its
  // partials/final are tagged distinctly from the utterance that just ended.
  state.utteranceSeq += 1;

  // Fresh utterance buffer for the two-tier quality re-decode + capture audit.
  resetPcm(state);

  // Open a recognizer for this utterance and flush the pre-roll into it.
  await openStt(state);
  for (const chunk of om.preRoll) {
    // Retain the 16 kHz pre-roll (the lead-in before VAD onset) for the quality
    // decode, and feed the recognizer whichever rate it wants.
    retainPcm(state, chunk.pcm16k);
    feedStt(state, chunk.native, chunk.pcm16k);
  }

  // Barge-in: VAD onset while an agent holds the floor → pause playback now.
  // We do not clear the floor yet — a backchannel resumes it; a real utterance
  // applies barge-in routing at speech-end.
  const holder = currentFloorHolder(state.threadId);
  if (holder) {
    // The interrupt is instant (below), but grant the interrupting utterance a
    // more generous finish window so the speaker can complete the thought they
    // cut in to say instead of dispatching their first fragment at the first pause.
    om.endpointer.setSilenceForCurrentRun(OPEN_MIC_BARGEIN_SILENCE_MS);
    const utteranceId = currentFloorUtteranceId(state.threadId);
    om.tentativeBargeIn = { agentId: holder, utteranceId };
    toThread(state.threadId, 'voice:interrupt', {
      voiceSessionId: state.voiceSessionId,
      utteranceId,
    });
  }
}

async function onOpenMicSpeechEnd(
  state: VoiceSessionState,
  clientId: string,
  voicedMs: number
): Promise<void> {
  const om = state.openMic;
  if (!om) return;
  om.inSpeech = false;

  // Pin the ending utterance's key now — the dispatch chain below runs async and
  // the next utterance may bump state.utteranceSeq before this final is emitted.
  const utteranceSeq = state.utteranceSeq;

  const stt = state.stt;
  state.stt = null;
  state.lastPartialAt = 0;

  // Always finalize the streaming tier at speech-end (~86 ms) — its transcript
  // drives the backchannel-vs-command + barge-in decisions inline (the quality
  // re-decode is too slow to run on the VAD chain; it happens on the dispatch
  // chain below and produces the dispatched text).
  let streamingText = '';
  if (stt) {
    try {
      streamingText = (await stt.finalize()).trim();
    } catch (err) {
      LogsService.warn('open-mic finalize failed', {
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

  // Consume the retained pcm now (a new utterance would reset it) so the
  // dispatch-chain quality decode + capture audit see this utterance's audio.
  const pcm = consumeUtterancePcm(state);
  dumpUtteranceIfEnabled(state.voiceSessionId, pcm);

  const tentative = om.tentativeBargeIn;
  om.tentativeBargeIn = null;

  // Backchannel filter: classify on the transcript, not duration alone. A
  // short filler ("mhm") or an empty burst is a backchannel; a short but
  // meaningful command ("stop", "no", "wait") is not — it must dispatch/barge-in.
  const meaningful = streamingText.length > 0 && !isBackchannelUtterance(voicedMs, streamingText);

  if (!meaningful) {
    // Not a real utterance. If we had paused a speaker, resume it by re-
    // broadcasting the floor (client plays its buffered audio through).
    if (tentative) {
      toThread(state.threadId, 'voice:floor', { holder: tentative.agentId });
    }
    toThread(state.threadId, 'voice:final', { text: '', messageId: null, utteranceSeq });
    return;
  }

  // Real utterance. If it interrupted a speaker, apply barge-in routing now:
  // route only to the interrupted agent, clear the floor, inject vs. abort.
  let bargeIn: BargeInTarget | null = null;
  if (tentative) {
    const interruptedAgentId = clearFloorForBargeIn(state.threadId) ?? tentative.agentId;
    const target: BargeInTarget = {
      agentId: interruptedAgentId,
      heardUpTo: tentative.heardUpTo,
    };
    if (
      decideBargeInAction({
        toolInFlight: isToolInFlight(state.threadId, interruptedAgentId),
      }) === 'abort-redispatch'
    ) {
      target.awaitTeardown = true;
      const aborted = abortThread(state.threadId);
      logger.info(
        `[voice] open-mic barge-in mid-speech → aborted ${aborted} run(s) ` +
          `[thread=${state.threadId}] [agent=${interruptedAgentId}]`
      );
    } else {
      logger.info(
        `[voice] open-mic barge-in mid-tool → will inject [thread=${state.threadId}] ` +
          `[agent=${interruptedAgentId}]`
      );
    }
    bargeIn = target;
  }

  // Finalize off the VAD chain: hand the quality re-decode (and, in full
  // Voice mode, the send) to a per-session chain so VAD frame processing never
  // stalls behind it. Dictation and Voice mode deliberately diverge here:
  // dictate-only returns the final transcript as an editable composer draft;
  // speak-enabled Voice mode auto-dispatches it into the conversational loop.
  // Serialized so two utterances can't finalize/send out of order.
  om.dispatchChain = om.dispatchChain
    // eslint-disable-next-line no-restricted-syntax -- intentional: the prior dispatch already logged its own failure in its trailing catch; this only isolates the chain
    .catch(() => {}) // isolate a prior dispatch's failure from this one
    .then(async () => {
      const resolved = await resolveFinal(state, streamingText, pcm);
      if (!state.speak) {
        toThread(state.threadId, 'voice:final', {
          text: resolved.text,
          messageId: null,
          utteranceSeq,
        });
        return;
      }
      await sendTranscript(state, clientId, resolved.text, bargeIn, utteranceSeq);
    })
    .catch((err) => {
      LogsService.warn('open-mic finalize/dispatch failed', {
        threadId: state.threadId,
        error: getErrorMessage(err),
      });
      voiceError(state.threadId, `Voice send failed: ${getErrorMessage(err)}`, true);
    });
}
