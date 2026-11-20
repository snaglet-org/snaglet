/**
 * VoiceSessionService — one active voice session per WS client.
 *
 * Responsibilities:
 *   - lifecycle: start (validate engine + dispatch mode + thread), stop, and
 *     teardown on client disconnect (floor auto-release + STT close);
 *   - inbound audio: base64 PCM16 → STT feed → throttled voice:partial;
 *   - finalize: STT final → the exact typed-user-message send path
 *     (chatHandlers.processChatSend), with pill-target @mentions appended and
 *     the message metadata stamped source='voice';
 *   - barge-in: route the next utterance only to the interrupted agent, clear
 *     the floor, and inject vs abort+redispatch per run phase;
 *   - targets: update the standing pill selection (voice:targets).
 *
 * The floor arbiter + TTS pipeline handle the outbound (spoken) direction; this
 * service just installs their per-thread sinks on start and removes them on stop.
 *
 * Orchestrator only — the cohesive seams live in sibling modules: voiceTransport
 * (S→C frames), sttIngest (band-limit + STT I/O + pcm buffer + two-tier final),
 * convergingPreview (live quality re-decode), openMicDriver (open-mic VAD),
 * appleDictation (open-mic dictation on Apple's recognizer, no VAD), and
 * voiceDispatch (compose mentions + heard-up-to → send).
 */

import { randomUUID } from 'crypto';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { logger } from '@server/config/logger';
import { setSession } from '@server/services/SocketService/store';
import { abortThread } from '@server/services/SocketService/abortStore';
import {
  emitVoiceModeEnabledEvent,
  emitVoiceModeDisabledEvent,
} from '@server/services/SocketService/threadEvents';
import { getVoiceEngine } from './engineAdapter';
import { base64ToPcm16 } from './audioCodec';
import { openFloor, closeFloor, notePlaybackDone, clearFloorForBargeIn } from './floorArbiter';
import { registerTtsSink, unregisterTtsSink } from './ttsPipeline';
import {
  markThreadVoiceActive,
  unmarkThreadVoiceActive,
  micClientsForThread,
} from './voiceSessionRegistry';
import { isToolInFlight, clearRunPhase } from './runPhaseTracker';
import { clearSynthesizedMs } from './ttsDurationTracker';
import { decideBargeInAction } from './bargeIn';
import { dumpUtteranceIfEnabled } from './voiceDebugDump';
import { VOICE_SAMPLE_RATE, previewDecodeMs } from './constants';
import {
  toThread as emitToThread,
  toClient as emitToClient,
  voiceError as emitVoiceError,
} from './voiceTransport';
import {
  readCaptureRate,
  bandLimitTo16k,
  feedStt,
  openStt,
  retainPcm,
  resetPcm,
  consumeUtterancePcm,
  resolveFinal,
} from './sttIngest';
import { runPreviewDecode } from './convergingPreview';
import { initOpenMic, feedOpenMic } from './openMicDriver';
import { initAppleDictation, feedAppleDictation } from './appleDictation';
import { sendTranscript } from './voiceDispatch';
import type {
  VoiceSessionStartPayload,
  VoiceAudioChunkPayload,
  VoiceUtteranceEndPayload,
  VoicePlaybackDonePayload,
  VoiceBargeInPayload,
  VoiceSessionStopPayload,
  VoiceTargetsPayload,
  VoiceAttachmentsPayload,
  VoiceSessionState,
  BargeInTarget,
} from './types';

const VOICE_SUPPORTED_DISPATCH_MODES: ReadonlySet<string> = new Set(['all', 'mentioned']);

/** What one in-flight voice:session:start shares with {@link VoiceSessionService.open}. */
interface StartAttempt {
  /** A newer start from the same client (or its disconnect) replaced this one. */
  superseded(): boolean;
  /** Report a handshake failure, tagged so the client can match it. */
  fail(message: string): void;
  /** The session this attempt registered, once it has. */
  state: VoiceSessionState | null;
}

class VoiceSessionService {
  private byClient = new Map<string, VoiceSessionState>();
  /** Latest voice:session:start per client; an older in-flight start yields to it. */
  private startAttempts = new Map<string, number>();

  /**
   * S→C voice frames ride the thread channel (channel === threadId) so the
   * client filters them exactly like chat events.
   */
  private toThread(threadId: string, type: string, payload: unknown): void {
    emitToThread(threadId, type, payload);
  }

  /** Direct-to-client — only for errors raised before a thread is bound. */
  private toClient(clientId: string, type: string, payload: unknown): void {
    emitToClient(clientId, type, payload);
  }

  private error(threadId: string, message: string, speakable: boolean, requestId?: string): void {
    emitVoiceError(threadId, message, speakable, requestId);
  }

  private require(clientId: string, voiceSessionId?: string): VoiceSessionState | null {
    const state = this.byClient.get(clientId);
    if (!state) return null;
    if (voiceSessionId && state.voiceSessionId !== voiceSessionId) return null;
    return state;
  }

  // Lifecycle

  async start(payload: VoiceSessionStartPayload, clientId: string): Promise<void> {
    const threadId = payload?.threadId;
    const requestId = payload?.requestId;
    if (!threadId) {
      // No channel to broadcast on — reply straight to the client.
      this.toClient(clientId, 'voice:error', {
        message: 'voice:session:start requires a threadId',
        speakable: false,
        ...(requestId ? { requestId } : {}),
      });
      return;
    }

    // A newer voice:session:start from this client (a quick off → on, or a
    // retry after a slow handshake) supersedes this one. Without this check the
    // two handshakes race, and the client can end up streaming audio under a
    // session id the server already replaced — dropped without a word.
    const attemptNo = (this.startAttempts.get(clientId) ?? 0) + 1;
    this.startAttempts.set(clientId, attemptNo);
    const attempt: StartAttempt = {
      superseded: () => this.startAttempts.get(clientId) !== attemptNo,
      // Tagged with the requestId so the client ends the right handshake at
      // once, with this reason, instead of waiting out its start timeout.
      fail: (message) => this.error(threadId, message, false, requestId),
      state: null,
    };
    try {
      await this.open(payload, clientId, threadId, attempt);
    } catch (err) {
      // Anything unexpected (a DB or session-store failure): undo what this
      // start registered and tell the client why, instead of leaving it to
      // time out on a generic "server didn't answer".
      if (attempt.state && this.byClient.get(clientId) === attempt.state) {
        this.teardown(clientId, { writeDisabledEvent: false });
      }
      attempt.fail(`Voice couldn't start: ${getErrorMessage(err)}`);
      logger.warn(`[voice] session start failed [thread=${threadId}]: ${getErrorMessage(err)}`);
    }
  }

  private async open(
    payload: VoiceSessionStartPayload,
    clientId: string,
    threadId: string,
    attempt: StartAttempt
  ): Promise<void> {
    // Engine gate (plan: engine null → voice:error {speakable:false}).
    const engine = await getVoiceEngine();
    if (attempt.superseded()) return;
    if (!engine) {
      attempt.fail("Voice isn't available: Snaglet's voice engine couldn't load.");
      return;
    }

    const thread = await Threads.findById(threadId).catch(() => null);
    if (attempt.superseded()) return;
    if (!thread) {
      attempt.fail(`Thread not found: ${threadId}`);
      return;
    }

    const participants = await ThreadParticipants.listByThread(threadId).catch(() => []);
    if (attempt.superseded()) return;
    const participantAgentIds = Array.from(
      new Set(participants.map((p) => p.agentId).filter((id): id is string => Boolean(id)))
    );
    if (participantAgentIds.length === 0) {
      attempt.fail('Voice needs an agent in this thread. Add one, then try again.');
      return;
    }

    // Routing determines which agents run, not whether voice is available. All
    // current routing modes share the same per-thread floor below, which keeps
    // generation and playback single-speaker even when All mode fans out.
    // Reject unknown future/corrupt values until their voice semantics are known.
    const dispatchMode = thread.dispatchMode ?? 'mentioned';
    if (!VOICE_SUPPORTED_DISPATCH_MODES.has(dispatchMode)) {
      attempt.fail(`Voice mode does not support routing mode '${String(dispatchMode)}'.`);
      return;
    }

    // Dictate and speak are independent flags. Default true when absent so an
    // older or partial payload keeps both on (the combined behavior).
    const dictate = payload.dictate ?? true;
    const speak = payload.speak ?? true;

    // Thread-level mic exclusivity (one window holds the mic), for dictate
    // sessions only: a speak-only session holds no mic, so it neither takes over
    // nor can be taken over here. If a different client already holds the mic on
    // this thread, this session takes over: tear the other one down via the
    // same path as a disconnect (STT closed, floor auto-released so parked runs
    // resume, TTS sink removed) and notify the displaced client so its toggle
    // reverts to off. The thread stays voice-on (this session re-enables it
    // below), so the displaced teardown writes no voice-disabled thread_event.
    // The ended frame goes direct to the displaced client, never the thread
    // channel, so the taking-over client doesn't also see it.
    if (dictate) {
      for (const otherClientId of micClientsForThread(threadId)) {
        if (otherClientId === clientId) continue; // same-client restart handled below
        const displaced = this.byClient.get(otherClientId);
        if (!displaced) continue;
        this.toClient(otherClientId, 'voice:session:ended', {
          voiceSessionId: displaced.voiceSessionId,
          reason: 'taken-over',
          message: 'voice session taken over by another window',
        });
        this.teardown(otherClientId, { writeDisabledEvent: false });
      }
    }

    // Replace any existing session on this client.
    const prior = this.byClient.get(clientId);
    if (prior) this.teardown(clientId, { writeDisabledEvent: prior.threadId !== threadId });

    // A voice session owns a chat session so it can reuse the exact send path.
    const chatSessionId = randomUUID();
    await setSession({
      id: chatSessionId,
      agentId: participantAgentIds[0]!,
      threadId,
      participantAgentIds,
      createdAt: Date.now(),
    });
    if (attempt.superseded()) return;

    const voiceSessionId = randomUUID();
    const state: VoiceSessionState = {
      voiceSessionId,
      clientId,
      threadId,
      chatSessionId,
      mode: payload.mode === 'open' ? 'open' : 'ptt',
      dictate,
      speak,
      participantAgentIds,
      targetAgentIds: (payload.targetAgentIds ?? []).filter(Boolean),
      attachmentImageIds: (payload.attachmentImageIds ?? []).filter(Boolean),
      stt: null,
      sttWantsNativeRate: false,
      captureSampleRate: VOICE_SAMPLE_RATE,
      decimator: null,
      partialTier: engine.sttTier ?? 'live',
      utteranceSeq: 0,
      utterancePcm: [],
      utterancePcmSamples: 0,
      bargeInTarget: null,
      openMic: null,
      appleDictation: null,
      previewTimer: null,
      previewDecodeInFlight: false,
      finalDecodeInFlight: false,
      lastPartialAt: 0,
      opening: false,
    };
    this.byClient.set(clientId, state);
    attempt.state = state;

    // Converging preview: while an utterance is active, periodically
    // re-decode the accumulated pcm with the quality tier and push it as a
    // tier:'quality' voice:partial so the live preview tracks the dispatched
    // final. Env 0 disables — no interval, zero cost. The decode itself runs in
    // the engine worker, so this only schedules; the event loop never blocks.
    //
    // Disabled when the engine has no quality re-decode tier (engine=apple): the
    // Apple sidecar's partials are already cased + punctuated (tagged
    // tier:'quality' in emitPartial) and its final is authoritative, so there is
    // nothing to converge — no timer, no re-decode.
    const cadenceMs = previewDecodeMs();
    if (cadenceMs > 0 && typeof engine.qualityDecode === 'function') {
      state.previewTimer = setInterval(() => runPreviewDecode(state), cadenceMs);
      state.previewTimer.unref?.();
    }

    // Speak gate: install the outbound (spoken) sinks for this thread → the
    // thread channel. A dictate-only session never opens the floor or
    // registers a TTS sink — nothing will ever be spoken, so nothing to arbit
    // or synthesize (floorArbiter's functions all no-op gracefully on a thread
    // with no open floor, and isThreadVoiceActive() — which reflects speak
    // clients only — stays false, so floor-gated generation / barge-in phase
    // tracking / VOICE_PROFILE_BLOCK all correctly treat this thread as
    // not-spoken).
    if (speak) {
      openFloor(threadId, {
        emitFloor: (holder) => this.toThread(threadId, 'voice:floor', { holder }),
      });
      registerTtsSink(threadId, {
        emitChunk: (p) => this.toThread(threadId, 'voice:tts:chunk', p),
        emitEnd: (p) => this.toThread(threadId, 'voice:tts:end', p),
      });
    }
    markThreadVoiceActive(threadId, clientId, { dictate, speak });

    /** Undo this start and tell the client why (the handshake's voice:error). */
    const refuse = (reason: string, what: string, err: unknown): void => {
      if (this.byClient.get(clientId) === state) {
        this.teardown(clientId, { writeDisabledEvent: false });
      }
      attempt.fail(`Voice input can't start: ${reason}`);
      logger.warn(`[voice] ${what} [thread=${threadId}]: ${getErrorMessage(err)}`);
    };

    // Dictate gate, open mic. Dictation on Apple's recognizer (macOS) ends
    // utterances from the audio level and Apple's own results (appleDictation),
    // so it needs no local voice-detection model: no VAD probe, no voice-model
    // download — only a check that Apple speech can run, refused with the fix
    // when it can't. Every other open-mic session (the all-local engine, or
    // Voice mode, whose barge-in needs instant onset detection) stands up
    // server-side VAD endpointing. That is required: an open mic without it
    // never finishes an utterance, so refuse the session with the reason
    // rather than start one that transcribes nothing.
    const appleDictation =
      dictate && !speak && state.mode === 'open' && engine.sttEngine === 'apple';
    if (appleDictation) {
      try {
        await engine.prepareStt?.();
      } catch (err) {
        refuse(getErrorMessage(err), 'apple STT unavailable', err);
        return;
      }
      // A newer start replaced this session while Apple speech started up.
      if (this.byClient.get(clientId) !== state) return;
      initAppleDictation(state, (err) => {
        this.endFailedSession(clientId, state, `Dictation stopped: ${getErrorMessage(err)}`);
      });
    } else if (dictate && state.mode === 'open') {
      try {
        await initOpenMic(state, engine);
      } catch (err) {
        // On a Mac that fell back to local STT, say why Apple speech wasn't used.
        const reason = engine.sttFallbackReason
          ? `${engine.sttFallbackReason}, and Snaglet's own voice detection couldn't load: ${getErrorMessage(err)}`
          : getErrorMessage(err);
        refuse(reason, 'open-mic VAD init failed', err);
        return;
      }
      // A newer start replaced this session while the VAD loaded.
      if (this.byClient.get(clientId) !== state) return;
    }

    // Speak gate: durable state fact ("voice mode enabled") — this thread_event
    // narrates that replies are being spoken aloud, so it belongs to the speak
    // side exactly like the profile block it pairs with (behavior rides the
    // ephemeral tail — see composeTurnContextTail). A dictate-only session
    // never narrates this (nothing is being spoken), and its teardown mirrors
    // this gate (see `teardown`'s `state.speak` check) so a dictate-only stop
    // never writes an orphan "disabled" event with no matching "enabled".
    if (speak) void emitVoiceModeEnabledEvent(threadId);

    // Warmup: proactively load the models this session uses (STT to dictate,
    // VAD for open-mic, TTS + one dummy synth to speak) so the first real
    // utterance skips the ~1.7s cold model load. Only those: a dictate-only
    // session must not fail on a voice model it never speaks with. Apple
    // dictation loads nothing here (prepareStt above already started Apple
    // speech). Fire-and-forget so the handshake stays snappy; a genuine
    // engine-init failure (missing models / addon) surfaces as a voice:error.
    const needs = {
      stt: dictate && !appleDictation,
      tts: speak,
      vad: dictate && state.mode === 'open' && !appleDictation,
    };
    if (engine.warmup && (needs.stt || needs.tts || needs.vad)) {
      void engine.warmup(undefined, needs).catch((err) => {
        this.error(threadId, `voice engine failed to initialize: ${getErrorMessage(err)}`, false);
        logger.warn(`[voice] warmup failed [thread=${threadId}]: ${getErrorMessage(err)}`);
      });
    }

    this.toThread(threadId, 'voice:session:started', {
      voiceSessionId,
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
    });
    LogsService.socket.event('voice session started', {
      threadId,
      mode: state.mode,
      endpointing: appleDictation ? 'apple' : state.openMic ? 'vad' : 'client',
      participants: participantAgentIds.length,
    });
  }

  /**
   * End a live session whose speech recognition stopped working, and tell its
   * window why (voice:session:ended turns the buttons off with this message).
   */
  private endFailedSession(clientId: string, state: VoiceSessionState, message: string): void {
    if (this.byClient.get(clientId) !== state) return;
    this.toClient(clientId, 'voice:session:ended', {
      voiceSessionId: state.voiceSessionId,
      reason: 'failed',
      message,
    });
    this.teardown(clientId, { writeDisabledEvent: true });
    logger.warn(`[voice] session ended [thread=${state.threadId}]: ${message}`);
  }

  stop(payload: VoiceSessionStopPayload | undefined, clientId: string): void {
    const state = this.require(clientId, payload?.voiceSessionId);
    if (!state) return;
    this.teardown(clientId, { writeDisabledEvent: true });
  }

  handleDisconnect(clientId: string): void {
    // Also cancels a start still in flight for this client (it sees itself
    // superseded), so a dropped socket never leaves a session behind.
    this.startAttempts.delete(clientId);
    if (!this.byClient.has(clientId)) return;
    // Disconnect: floor auto-releases, STT closes, parked runs resume as text.
    this.teardown(clientId, { writeDisabledEvent: true });
  }

  private teardown(clientId: string, opts: { writeDisabledEvent: boolean }): void {
    const state = this.byClient.get(clientId);
    if (!state) return;
    try {
      state.stt?.close();
    } catch {
      /* best-effort */
    }
    if (state.openMic) {
      void state.openMic.vad.close().catch((err) => {
        logger.debug(`[voice] VAD close failed during teardown: ${getErrorMessage(err)}`);
      });
      state.openMic = null;
    }
    // Its frame chain checks this and stops; the recognizer was closed above.
    state.appleDictation = null;
    if (state.previewTimer) {
      clearInterval(state.previewTimer);
      state.previewTimer = null;
    }
    closeFloor(state.threadId);
    unregisterTtsSink(state.threadId);
    // Sidecars are process-wide engines, so stopping the last voice session
    // must tear them down too; shutdown is idempotent and re-arms on next start.
    if (this.byClient.size === 1) {
      void getVoiceEngine()
        .then((engine) => engine?.shutdown?.())
        .catch((err) => {
          logger.warn(`[voice] engine shutdown failed: ${getErrorMessage(err)}`);
        });
    }
    unmarkThreadVoiceActive(state.threadId, clientId);
    clearRunPhase(state.threadId);
    // lastPartialAt + opening live on `state` — removing it from byClient drops
    // them with the session (no class-level map to clean up).
    this.byClient.delete(clientId);
    // Mirror the start()-side gate: only a session that ever narrated "enabled"
    // (speak === true) should narrate "disabled" — a dictate-only session never
    // wrote the enabled event, so its teardown must not write an orphan
    // disabled one either.
    if (opts.writeDisabledEvent && state.speak) void emitVoiceModeDisabledEvent(state.threadId);
    LogsService.socket.event('voice session stopped', { threadId: state.threadId });
  }

  // Inbound audio

  audioChunk(payload: VoiceAudioChunkPayload, clientId: string): void {
    const state = this.require(clientId, payload?.voiceSessionId);
    if (!state) return;
    // Dictate gate: a speak-only session holds no mic — defensively drop any
    // stray audio frame rather than lazily opening an STT session for it (the
    // client's composer never shows mic controls for a speak-only session, so
    // this only guards against a stale/buggy client).
    if (!state.dictate) return;

    // The client captures at the AudioContext's native rate and sends it
    // (voice:audio:chunk.sampleRate). Band-limit to 16 kHz here for the
    // silero VAD + local STT + the retained quality-decode buffer; an Apple STT
    // session is fed the native pcm untouched (the sidecar down-converts itself).
    state.captureSampleRate = readCaptureRate(payload);
    const native = base64ToPcm16(payload.pcm16);
    const pcm16k = bandLimitTo16k(state, native);

    // Open-mic dictation on Apple: one continuous recognizer stream, endpointed
    // from the audio level + Apple's results (no VAD).
    if (state.mode === 'open' && state.appleDictation) {
      feedAppleDictation(state, native, pcm16k);
      return;
    }

    // Open-mic: the server VADs continuously and endpoints (no PTT boundary).
    if (state.mode === 'open' && state.openMic) {
      feedOpenMic(state, clientId, native, pcm16k);
      return;
    }

    // Retain the full utterance pcm (16 kHz, incl. the lead-in the zipformer
    // drops) for the two-tier quality re-decode + capture audit — before the
    // STT-ready gate.
    retainPcm(state, pcm16k);

    if (!state.stt) {
      // Lazily open an STT session for this utterance; wire partials once. Guard
      // against a burst of frames each spawning a session before the first
      // open resolves. Frames that arrive before the session is ready are
      // dropped from the recognizer (a few ms of lead-in) — acceptable for PTT;
      // they are still retained above for the quality re-decode.
      if (!state.opening) {
        // A new PTT utterance begins here — bump the per-utterance key so its
        // partials/final are tagged distinctly from the previous utterance.
        state.utteranceSeq += 1;
        state.opening = true;
        void openStt(state).finally(() => {
          state.opening = false;
        });
      }
      return;
    }
    feedStt(state, native, pcm16k);
  }

  async utteranceEnd(payload: VoiceUtteranceEndPayload, clientId: string): Promise<void> {
    const state = this.require(clientId, payload?.voiceSessionId);
    if (!state) return;
    // Dictate gate (mirrors audioChunk): no mic on a speak-only session, so
    // there is never an STT session to finalize.
    if (!state.dictate) return;

    // Open-mic endpoints server-side — the VAD owns finalize. A stray client
    // voice:utterance:end here would finalize the VAD-owned recognizer mid-stream
    // → double dispatch / corrupted STT. Ignore it entirely in open mode.
    if (state.mode === 'open') {
      logger.debug(`[voice] ignoring client utterance:end in open mode [thread=${state.threadId}]`);
      return;
    }

    // Pin the ending utterance's key so voice:final matches the partials the
    // client already keyed to this utterance.
    const utteranceSeq = state.utteranceSeq;

    const stt = state.stt;
    state.stt = null;
    state.lastPartialAt = 0;
    if (!stt) {
      resetPcm(state); // no utterance opened — drop any retained lead-in
      return;
    }

    let streamingText = '';
    try {
      streamingText = (await stt.finalize()).trim();
    } catch (err) {
      LogsService.warn('voice finalize failed', {
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

    // Two-tier: capture-audit the retained pcm, then re-decode it with the
    // cased+punctuated Moonshine tier → the dispatched final (fallback: the
    // normalized streaming final). Applies to voice:final and the sent message.
    const pcm = consumeUtterancePcm(state);
    dumpUtteranceIfEnabled(state.voiceSessionId, pcm);
    const transcript = (await resolveFinal(state, streamingText, pcm)).text;

    // Consume the one-shot barge-in route (set by the voice:bargein handler).
    const bargeIn = state.bargeInTarget;
    state.bargeInTarget = null;

    // Esc bail-out, or a dictation-only session (speak === false): finalize +
    // echo the transcript back, but do not dispatch — the client drops it into
    // the composer as an editable draft. By design, dictation-only never
    // auto-sends. A speak session falls through to the normal dispatch below.
    // A canceled/never-sent utterance never carries a barge-in route forward.
    if (payload?.cancelDispatch === true || !state.speak) {
      this.toThread(state.threadId, 'voice:final', {
        text: transcript,
        messageId: null,
        utteranceSeq,
      });
      return;
    }

    if (transcript.length === 0) {
      // Nothing heard — surface an empty final so the composer clears.
      this.toThread(state.threadId, 'voice:final', { text: '', messageId: null, utteranceSeq });
      return;
    }

    await sendTranscript(state, clientId, transcript, bargeIn, utteranceSeq);
  }

  // Floor + barge-in

  playbackDone(payload: VoicePlaybackDonePayload, clientId: string): void {
    const state = this.require(clientId, payload?.voiceSessionId);
    if (!state || !payload?.utteranceId) return;
    notePlaybackDone(state.threadId, payload.utteranceId);
    // Utterance fully played — no further barge-in against it; drop its duration.
    clearSynthesizedMs(payload.utteranceId);
  }

  bargeIn(payload: VoiceBargeInPayload, clientId: string): void {
    const state = this.require(clientId, payload?.voiceSessionId);
    if (!state) return;

    // Open-mic: barge-in is server-driven (VAD onset). A client voice:bargein
    // during the paused window only supplies heardUpTo (playedMs) for the marker;
    // the routing itself is applied at speech-end (backchannel-aware).
    if (state.mode === 'open' && state.openMic?.tentativeBargeIn) {
      state.openMic.tentativeBargeIn.heardUpTo = payload.heardUpTo;
      return;
    }

    // Immediate: clear the floor + flush the interrupted run's pending audio.
    const interruptedAgentId = clearFloorForBargeIn(state.threadId);
    if (!interruptedAgentId) {
      // Nothing was speaking — treat the coming utterance as a normal send.
      state.bargeInTarget = null;
      return;
    }

    const target: BargeInTarget = {
      agentId: interruptedAgentId,
      heardUpTo: payload.heardUpTo,
    };

    // Decide inject vs abort before the user's utterance finalizes so, by send
    // time, a mid-speech run has released its lock and redispatches fresh. Phase
    // is read for the specific interrupted agent (group precision).
    const action = decideBargeInAction({
      toolInFlight: isToolInFlight(state.threadId, interruptedAgentId),
    });
    if (action === 'abort-redispatch') {
      target.awaitTeardown = true;
      const aborted = abortThread(state.threadId);
      logger.info(
        `[voice] barge-in mid-speech → aborted ${aborted} run(s) [thread=${state.threadId}] ` +
          `[agent=${interruptedAgentId}]`
      );
    } else {
      logger.info(
        `[voice] barge-in mid-tool → will inject [thread=${state.threadId}] [agent=${interruptedAgentId}]`
      );
    }
    state.bargeInTarget = target;
  }

  // Targets

  setTargets(payload: VoiceTargetsPayload, clientId: string): void {
    const state = this.require(clientId, payload?.voiceSessionId);
    if (!state) return;
    state.targetAgentIds = (payload.targetAgentIds ?? []).filter(Boolean);
  }

  /** Live sync of the composer's attached image ids (see VoiceAttachmentsPayload). */
  setAttachments(payload: VoiceAttachmentsPayload, clientId: string): void {
    const state = this.require(clientId, payload?.voiceSessionId);
    if (!state) return;
    state.attachmentImageIds = (payload.attachmentImageIds ?? []).filter(Boolean);
  }

  /** Test-only reset. */
  __reset(): void {
    for (const clientId of Array.from(this.byClient.keys())) {
      this.teardown(clientId, { writeDisabledEvent: false });
    }
    this.byClient.clear();
    this.startAttempts.clear();
  }
}

export const voiceSessionService = new VoiceSessionService();
