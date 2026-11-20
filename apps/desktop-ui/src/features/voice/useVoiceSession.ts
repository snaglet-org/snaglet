// Voice session lifecycle over the app's WS client: the state machine (off →
// connecting → idle → listening / agent-speaking), mic capture, TTS playback,
// barge-in and earcons. Audio and WS are injected so it runs under jsdom.
// Every end the caller did not ask for goes through `endSession`, which says
// why and calls `onEnded` so the caller's toggle reverts instead of retrying.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { useWs } from '@desktop/ws/useWs';
import { showToast } from '@desktop/utils/toast';
import { MicCapture } from './audio/MicCapture';
import { micErrorMessage } from './audio/micError';
import { PlaybackQueue } from './audio/PlaybackQueue';
import { Earcons } from './audio/Earcons';
import { emitVoiceComposer } from './voiceDraftBus';
import { convergeTranscript, isRevision } from './voiceComposerDraft';
import {
  CHAT_AGENT_STATUS,
  VOICE_C2S,
  VOICE_ERROR_TOAST_MS,
  VOICE_MIC_START_TIMEOUT_MS,
  VOICE_PREROLL_CHUNKS,
  VOICE_S2C,
  VOICE_SAMPLE_RATE,
  VOICE_START_TIMEOUT_MS,
  type VoiceMode,
} from './voiceConstants';
import type {
  MicDeviceChange,
  VoiceAttachmentsSetPayload,
  VoiceErrorPayload,
  VoiceFinalPayload,
  VoiceFloorPayload,
  VoicePartialPayload,
  VoicePhase,
  VoiceSessionDeps,
  VoiceSessionEndedPayload,
  VoiceSessionStartPayload,
  VoiceSessionStartedPayload,
  VoiceTargetsSetPayload,
  VoiceTtsChunkPayload,
  VoiceTtsEndPayload,
} from './voiceTypes';

const DEFAULT_DEPS: VoiceSessionDeps = {
  createMic: (opts) => new MicCapture(opts),
  createPlayback: (opts) => new PlaybackQueue(opts),
  createEarcons: () => new Earcons(),
  now: () => Date.now(),
};

const NOT_CONNECTED_MESSAGE =
  "Voice can't start while Snaglet is disconnected from its server. Try again in a moment.";
const NO_ANSWER_MESSAGE =
  "Voice didn't start: Snaglet's server didn't answer. Try again in a moment.";
const MIC_TIMEOUT_MESSAGE =
  "The microphone didn't start. If you were asked for microphone access, allow it, then try again.";
const TAKEN_OVER_MESSAGE = 'voice session taken over by another window';
const COMPAT_CAPTURE_NOTICE = 'Using compatibility microphone capture';

/** A fresh id per voice:session:start, unique enough across this app's windows. */
function newRequestId(): string {
  return `vs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface UseVoiceSessionOptions {
  /** Wire mode. Product callers use `open`; `ptt` remains server compatibility only. */
  mode?: VoiceMode;
  /**
   * Dictate/speak flags, independent of `mode`. When omitted, the
   * voice:session:start payload omits them too and the server treats them as
   * `true`. VoiceSessionContext always passes both.
   */
  dictate?: boolean;
  speak?: boolean;
  /** Pill selection (provider-owned). Rides voice:session:start and, on change
   *  while active, the optional voice:targets:set frame. */
  targetAgentIds?: string[];
  /** Composer image attachments (provider-owned, mirrored from the composer).
   *  Rides voice:session:start and, on change while active, voice:attachments:set,
   *  so a voice-dictated message carries the user's attachments. */
  attachmentImageIds?: string[];
  /** Override audio/clock factories (tests). */
  deps?: Partial<VoiceSessionDeps>;
  /** Finalized user transcript arrived (the server also persists it as a chat
   *  message, so callers usually just clear their own UI). */
  onFinal?: (p: VoiceFinalPayload) => void;
  onError?: (p: VoiceErrorPayload) => void;
  /** The session ended without stop() being called (see endSession). The
   *  user has already been told why; drop any "on" state instead of retrying. */
  onEnded?: () => void;
}

export interface VoiceSessionApi {
  phase: VoicePhase;
  capturing: boolean;
  agentSpeaking: boolean;
  floorHolder: string | null;
  lastError: string | null;
  /** Label of the live input device (MediaStreamTrack.label), or null. Surfaces
   *  which mic is capturing so silent device switches (Continuity) are visible. */
  inputDevice: string | null;
  /** True only after microphone permission and capture startup complete. */
  micReady: boolean;
  voiceSessionId: string | null;
  /** Begin the handshake (no-op unless off). */
  start: () => void;
  /** End the session + tear down audio. */
  stop: () => void;
  /** Toggle: start when off, stop otherwise. */
  toggle: () => void;
  /** PTT press — barge-in if an agent is speaking, then capture. */
  pttPress: () => void;
  /** PTT release — stop capture + voice:utterance:end. */
  pttRelease: () => void;
  /**
   * Esc bail-out. Cancels auto-dispatch of the current utterance: the finalized
   * STT text is routed into the composer as an editable draft instead of being
   * sent. Valid while capturing or during the finalize beat before voice:final.
   */
  requestBail: () => void;
}

type SessionStatus = 'off' | 'connecting' | 'active';

export function useVoiceSession(
  threadId: string,
  opts: UseVoiceSessionOptions = {}
): VoiceSessionApi {
  const { send, addMessageListener, connectionState } = useWs();
  const connectionStateRef = useRef(connectionState);
  connectionStateRef.current = connectionState;

  const [status, setStatus] = useState<SessionStatus>('off');
  const [capturing, setCapturing] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [floorHolder, setFloorHolder] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [inputDevice, setInputDevice] = useState<string | null>(null);
  const [micReady, setMicReady] = useState(false);
  const [voiceSessionId, setVoiceSessionId] = useState<string | null>(null);
  /** Bumped to force the hot-mic effect to rebuild the capture device (a track
   *  that ended out from under us). */
  const [micNonce, setMicNonce] = useState(0);

  // Deps are frozen once — factories must be stable across renders.
  const depsRef = useRef<VoiceSessionDeps>({ ...DEFAULT_DEPS, ...opts.deps });

  // Mirrors of props/state the stable WS handler + actions read.
  const statusRef = useRef<SessionStatus>('off');
  const capturingRef = useRef(false);
  const voiceSessionIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  /** The mic's native capture rate (from onChunk); sent on every audio:chunk. */
  const captureRateRef = useRef(VOICE_SAMPLE_RATE);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** requestId of the voice:session:start awaiting its answer. */
  const pendingStartRef = useRef<string | null>(null);
  /** Starts given up on while connecting (timed out / stopped). The server may
   *  still open them; a late voice:session:started for one is stopped. */
  const abandonedStartsRef = useRef<Set<string>>(new Set());
  const modeRef = useRef<VoiceMode>(opts.mode ?? 'ptt');
  modeRef.current = opts.mode ?? 'ptt';
  // Dictate/speak kept raw (possibly undefined) so session:start can omit
  // them; only `effectiveDictate`/`effectiveSpeak` below (internal logic, never
  // the wire payload) apply the `?? true` default.
  const dictateOptRef = useRef<boolean | undefined>(opts.dictate);
  dictateOptRef.current = opts.dictate;
  const speakOptRef = useRef<boolean | undefined>(opts.speak);
  speakOptRef.current = opts.speak;
  const effectiveDictate = opts.dictate ?? true;
  const effectiveSpeak = opts.speak ?? true;
  const targetsRef = useRef<string[]>(opts.targetAgentIds ?? []);
  const attachmentsRef = useRef<string[]>(opts.attachmentImageIds ?? []);
  const onFinalRef = useRef(opts.onFinal);
  onFinalRef.current = opts.onFinal;
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;
  const onEndedRef = useRef(opts.onEnded);
  onEndedRef.current = opts.onEnded;

  const micRef = useRef<ReturnType<VoiceSessionDeps['createMic']> | null>(null);
  /** Auto-rebuilds spent on a yanked mic this session (capped at one so a truly
   *  gone device can't spin a reconnect loop). Reset on teardown. */
  const micRebuildsRef = useRef(0);
  /** PTT pre-roll ring (~300 ms of trailing chunks kept while not transmitting;
   *  flushed ahead of live audio on press so the first word isn't clipped). */
  const prerollRef = useRef<string[]>([]);
  const playbackRef = useRef<ReturnType<VoiceSessionDeps['createPlayback']> | null>(null);
  const earconsRef = useRef<ReturnType<VoiceSessionDeps['createEarcons']> | null>(null);
  /** Utterances with audio in flight (chunk seen, playback:done not yet sent). */
  const speakingIdsRef = useRef<Set<string>>(new Set());
  /** Esc bail requested for the current utterance → route final to composer. */
  const bailPendingRef = useRef(false);
  /** utterance:end sent, voice:final not yet received (the finalize beat). */
  const awaitingFinalRef = useRef(false);
  /** Open-mic: playback paused by a voice:interrupt, awaiting resume/flush. */
  const pausedRef = useRef(false);
  /** Mirror of floorHolder for the stable WS handler (who is speaking now). */
  const floorHolderRef = useRef<string | null>(null);
  /** Holder we paused on a voice:interrupt: a same-holder re-grant = backchannel
   *  (resume); null/different = real barge-in (flush stale audio first). */
  const pausedHolderRef = useRef<string | null>(null);
  /** Mode the active session was handshaken with — the server only learns the
   *  mode once (on session:start), so a mid-session flip needs a re-handshake. */
  const sessionModeRef = useRef<VoiceMode>(opts.mode ?? 'ptt');
  /**
   * Dictate/speak flags (defaulted) the active session was handshaken with;
   * mirrors sessionModeRef. Read by the voice:final handler (a dictate-only
   * session's finalized transcript is never dispatched — see the case below)
   * and by the re-handshake effect (a live flip needs stop→start, just like a
   * capture-mode flip, since the server only learns flags on session:start).
   */
  const sessionDictateRef = useRef<boolean>(opts.dictate ?? true);
  const sessionSpeakRef = useRef<boolean>(opts.speak ?? true);
  /** Converging preview → composer: the last quality re-decode + last live
   *  partial for the in-flight utterance, and whether we're currently driving the
   *  composer (so a no-dispatch burst only reverts a stash we actually took). */
  const qualityTextRef = useRef('');
  const liveTextRef = useRef('');
  const voiceComposerActiveRef = useRef(false);
  /**
   * Per-utterance key of the utterance the converging preview is currently
   * tracking (from the server's voice:partial/voice:final `utteranceSeq`). When a
   * partial arrives with a new key the tier accumulation resets at once,
   * without waiting for the previous utterance's late voice:final, so
   * utterance B never renders on top of A's stale quality tier. null = no
   * utterance keyed yet, or a server that omits the field.
   */
  const utteranceSeqRef = useRef<number | null>(null);

  const clearStartTimer = useCallback(() => {
    if (startTimerRef.current) {
      clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }
  }, []);

  const clearMicTimer = useCallback(() => {
    if (micTimerRef.current) {
      clearTimeout(micTimerRef.current);
      micTimerRef.current = null;
    }
  }, []);

  // Begin driving the composer for a fresh utterance: tell it to stash the
  // user's typed draft, and reset the per-utterance tier accumulation. Idempotent
  // within an utterance (a press then partials, or open-mic's first partial).
  const beginVoiceComposer = useCallback(() => {
    if (voiceComposerActiveRef.current) return;
    voiceComposerActiveRef.current = true;
    qualityTextRef.current = '';
    liveTextRef.current = '';
    emitVoiceComposer({ kind: 'start', threadId });
  }, [threadId]);

  const onUtteranceDone = useCallback(
    (utteranceId: string) => {
      const sid = voiceSessionIdRef.current;
      if (sid) {
        send({ type: VOICE_C2S.playbackDone, payload: { voiceSessionId: sid, utteranceId } });
      }
      speakingIdsRef.current.delete(utteranceId);
      if (speakingIdsRef.current.size === 0) setAgentSpeaking(false);
    },
    [send]
  );

  const ensurePlayback = useCallback(() => {
    if (!playbackRef.current) {
      playbackRef.current = depsRef.current.createPlayback({ onUtteranceDone });
    }
    return playbackRef.current;
  }, [onUtteranceDone]);

  const ensureEarcons = useCallback(() => {
    if (!earconsRef.current) earconsRef.current = depsRef.current.createEarcons();
    return earconsRef.current;
  }, []);

  const teardown = useCallback(() => {
    if (statusRef.current === 'connecting' && pendingStartRef.current) {
      abandonedStartsRef.current.add(pendingStartRef.current);
    }
    pendingStartRef.current = null;
    clearStartTimer();
    clearMicTimer();
    micRef.current?.stop();
    micRef.current = null;
    prerollRef.current = [];
    playbackRef.current?.dispose();
    playbackRef.current = null;
    earconsRef.current?.dispose();
    earconsRef.current = null;
    speakingIdsRef.current.clear();
    voiceSessionIdRef.current = null;
    statusRef.current = 'off';
    capturingRef.current = false;
    bailPendingRef.current = false;
    awaitingFinalRef.current = false;
    pausedRef.current = false;
    floorHolderRef.current = null;
    pausedHolderRef.current = null;
    seqRef.current = 0;
    micRebuildsRef.current = 0;
    // If we tear down mid-capture (stop / unmount / takeover while speaking),
    // revert the composer to the stashed draft so a half-spoken transcript never
    // gets stranded in the input.
    if (voiceComposerActiveRef.current) {
      voiceComposerActiveRef.current = false;
      emitVoiceComposer({ kind: 'revert', threadId });
    }
    qualityTextRef.current = '';
    liveTextRef.current = '';
    utteranceSeqRef.current = null;
    setVoiceSessionId(null);
    setStatus('off');
    setCapturing(false);
    setAgentSpeaking(false);
    setFloorHolder(null);
    setInputDevice(null);
    setMicReady(false);
  }, [clearStartTimer, clearMicTimer, threadId]);

  /**
   * End the session without the caller asking: say why (toast + lastError),
   * stop the server side if it has one, tear down, and report it through
   * onEnded so the caller's toggle reverts instead of starting again.
   */
  const endSession = useCallback(
    (message: string, { notifyServer = true }: { notifyServer?: boolean } = {}) => {
      const sid = voiceSessionIdRef.current;
      if (notifyServer && sid) {
        send({ type: VOICE_C2S.sessionStop, payload: { voiceSessionId: sid } });
      }
      teardown();
      setLastError(message);
      showToast(message, { durationMs: VOICE_ERROR_TOAST_MS });
      onEndedRef.current?.();
    },
    [send, teardown]
  );

  // A capture device changed underfoot (track ended / OS default input switched).
  // Make the silent switch visible: error earcon, toast and surfaced state. On
  // a yanked track, rebuild the hot mic once (getUserMedia default) so capture
  // resumes on the current default device; the cap stops a gone device from
  // spinning a reconnect loop. Devices are never switched beyond that default.
  const handleDeviceChange = useCallback(
    (info: MicDeviceChange) => {
      const label = info.label || 'unknown device';
      const message =
        info.reason === 'track-ended'
          ? `Microphone disconnected: ${label}`
          : `Microphone changed: ${label}`;
      setInputDevice(label);
      setLastError(message);
      ensureEarcons().error();
      showToast(message);
      if (info.reason === 'track-ended' && micRebuildsRef.current < 1) {
        micRebuildsRef.current += 1;
        setMicNonce((n) => n + 1);
      }
    },
    [ensureEarcons]
  );

  const handleFrame = useCallback(
    (msg: WsMessage) => {
      const type = msg.type;

      // "Heard you" earcon rides the existing agent-thinking status.
      if (type === CHAT_AGENT_STATUS) {
        if (statusRef.current !== 'active') return;
        if (msg.channel != null && msg.channel !== threadId) return;
        const p = msg.payload as { status?: string } | null;
        if (p?.status === 'thinking') ensureEarcons().thinkingTick();
        return;
      }

      if (!type.startsWith('voice:')) return;
      // Broadcasts carry channel = threadId; accept channel-less frames too.
      if (msg.channel != null && msg.channel !== threadId) return;

      switch (type) {
        case VOICE_S2C.sessionStarted: {
          const p = msg.payload as VoiceSessionStartedPayload;
          // The late answer to a start we gave up on: that session is live on
          // the server with nobody using it — stop it.
          if (p.requestId && abandonedStartsRef.current.delete(p.requestId)) {
            send({ type: VOICE_C2S.sessionStop, payload: { voiceSessionId: p.voiceSessionId } });
            break;
          }
          // Only the window that initiated the handshake cares about this frame.
          // It rides the thread channel, so a second window starting its own
          // session on this thread would otherwise clobber our id or re-activate
          // a window we just tore down. Ignore it unless it answers our
          // handshake; a frame without a requestId is accepted while connecting.
          if (statusRef.current !== 'connecting') break;
          if (p.requestId && p.requestId !== pendingStartRef.current) break;
          pendingStartRef.current = null;
          clearStartTimer();
          voiceSessionIdRef.current = p.voiceSessionId;
          statusRef.current = 'active';
          setVoiceSessionId(p.voiceSessionId);
          setStatus('active');
          setLastError(null);
          ensurePlayback();
          ensureEarcons();
          break;
        }
        case VOICE_S2C.partial: {
          // The live transcript renders into the composer. Quality re-decodes are
          // authoritative (sticky) and replace; live partials (or a frame with no
          // tier) extend the tail.
          const p = msg.payload as VoicePartialPayload;
          const text = p.text ?? '';
          beginVoiceComposer();
          // A partial with a new per-utterance key means a new utterance began:
          // reset the tier accumulation at once (not on the previous utterance's
          // late voice:final), so B's preview never merges with A's quality tier.
          const seq = p.utteranceSeq;
          if (typeof seq === 'number' && utteranceSeqRef.current !== seq) {
            utteranceSeqRef.current = seq;
            qualityTextRef.current = '';
            liveTextRef.current = '';
          }
          // Revising cue: a quality re-decode that changes already-shown words
          // rather than extending the tail. Compare against the previous quality
          // text (still in the ref until overwritten below). Live partials never
          // trigger the cue.
          const isRevising =
            p.tier === 'quality' &&
            qualityTextRef.current.trim().length > 0 &&
            isRevision(qualityTextRef.current, text);
          if (p.tier === 'quality') qualityTextRef.current = text;
          else liveTextRef.current = text;
          emitVoiceComposer({
            kind: 'update',
            threadId,
            text: convergeTranscript(qualityTextRef.current, liveTextRef.current),
            isRevising,
          });
          break;
        }
        case VOICE_S2C.final: {
          const p = msg.payload as VoiceFinalPayload;
          // A final whose key is older than the utterance being captured is
          // stale: a newer utterance owns the composer. It was still dispatched
          // (the message row exists), so run the app-level callback but leave
          // the composer alone.
          const finalSeq = p.utteranceSeq;
          const curSeq = utteranceSeqRef.current;
          if (typeof finalSeq === 'number' && typeof curSeq === 'number' && finalSeq < curSeq) {
            onFinalRef.current?.(p);
            break;
          }
          awaitingFinalRef.current = false;
          const wasActive = voiceComposerActiveRef.current;
          voiceComposerActiveRef.current = false;
          qualityTextRef.current = '';
          liveTextRef.current = '';
          const finalText = p.text ?? '';
          if (bailPendingRef.current) {
            // Esc bail: server suppressed dispatch. Merge the transcript into the
            // composer (stash + transcript) as an editable draft — nothing lost.
            bailPendingRef.current = false;
            emitVoiceComposer({ kind: 'bail', threadId, text: finalText });
          } else if (finalText.trim().length === 0) {
            // No-dispatch burst (backchannel / nothing heard): revert to the
            // stashed draft — nothing was sent, so the composer settles nothing.
            if (wasActive) emitVoiceComposer({ kind: 'revert', threadId });
            onFinalRef.current?.(p);
          } else if (!sessionSpeakRef.current) {
            // Dictate-only (speak off for this final's session): the server did
            // not dispatch it. Merge it into the composer as a draft via the
            // Esc-bail bus event, but still notify onFinal (it is a normal end).
            // A final with no partial before it never stashed the composer, so
            // begin the capture first; the draft is kept and this text appended.
            if (!wasActive) emitVoiceComposer({ kind: 'start', threadId });
            emitVoiceComposer({ kind: 'bail', threadId, text: finalText });
            onFinalRef.current?.(p);
          } else {
            // Dispatched: settle the composer on exactly what was sent, then it
            // restores the stash. The sent bubble appears via the normal flow.
            // With no partial before it, stash first (as above) so the restore
            // brings back the typed draft instead of clearing it.
            if (!wasActive) emitVoiceComposer({ kind: 'start', threadId });
            emitVoiceComposer({ kind: 'settle', threadId, text: finalText });
            onFinalRef.current?.(p);
          }
          break;
        }
        case VOICE_S2C.ttsChunk: {
          const p = msg.payload as VoiceTtsChunkPayload;
          // enqueueChunk returns false when PlaybackQueue's deadIds fence rejects
          // a straggler chunk for an utterance a flush() already canceled (the
          // server's synthesis abort is checked between frames, not instantly, so
          // an in-flight chunk can still land after). Only mark the utterance
          // "speaking" when the chunk was actually accepted — otherwise a fenced
          // straggler leaks its id into speakingIdsRef and agentSpeaking/phase
          // never flips back (the mic/orb indicator stays wrongly lit).
          const accepted = ensurePlayback().enqueueChunk(p);
          if (accepted) {
            speakingIdsRef.current.add(p.utteranceId);
            setAgentSpeaking(true);
          }
          break;
        }
        case VOICE_S2C.ttsEnd: {
          const p = msg.payload as VoiceTtsEndPayload;
          playbackRef.current?.markEnd(p.utteranceId);
          break;
        }
        case VOICE_S2C.interrupt: {
          // Open-mic: server VAD heard us cut in. Pause playback instantly and
          // report how far we got so the server can mark heard-up-to; it will
          // resume us (backchannel) or clear the floor (real barge-in).
          const heard = playbackRef.current?.pause?.() ?? null;
          pausedRef.current = true;
          // Remember who we paused: only a same-holder re-grant is a backchannel.
          pausedHolderRef.current = floorHolderRef.current;
          const sid = voiceSessionIdRef.current;
          if (sid) {
            send({
              type: VOICE_C2S.bargein,
              payload: { voiceSessionId: sid, ...(heard ? { heardUpTo: heard } : {}) },
            });
          }
          break;
        }
        case VOICE_S2C.floor: {
          const holder = (msg.payload as VoiceFloorPayload).holder ?? null;
          floorHolderRef.current = holder;
          setFloorHolder(holder);
          if (pausedRef.current) {
            // The server resolved our interrupt. Resume without flushing only when
            // it re-granted the floor to the speaker we paused (a backchannel).
            // Otherwise (floor cleared, or a different holder) the paused
            // utterance was cut: flush its buffered chunks before resuming so
            // stale audio never plays over the next speaker.
            pausedRef.current = false;
            const backchannelResume = holder !== null && holder === pausedHolderRef.current;
            if (!backchannelResume) {
              playbackRef.current?.flush();
              // The flushed utterance's audio was discarded, not played out, so
              // its onUtteranceDone never fires. Clear its id here or
              // agentSpeaking and the mic-orb indicator stay on (pttPress does
              // the same on its barge-in flush).
              speakingIdsRef.current.clear();
              setAgentSpeaking(false);
            }
            playbackRef.current?.resume?.();
            pausedHolderRef.current = null;
          }
          break;
        }
        case VOICE_S2C.error: {
          const p = msg.payload as VoiceErrorPayload;
          if (p.requestId) {
            // The server refused a start. Ours: end the handshake now with its
            // reason instead of waiting out the start timeout. One we already
            // gave up on: the reason still explains the failure, so show it.
            // Anyone else's (another window on this thread): not ours.
            if (p.requestId === pendingStartRef.current && statusRef.current === 'connecting') {
              pendingStartRef.current = null;
              endSession(p.message, { notifyServer: false });
              onErrorRef.current?.(p);
            } else if (abandonedStartsRef.current.delete(p.requestId)) {
              setLastError(p.message);
              showToast(p.message, { durationMs: VOICE_ERROR_TOAST_MS });
            }
            break;
          }
          ensureEarcons().error();
          setLastError(p.message);
          showToast(p.message, { durationMs: VOICE_ERROR_TOAST_MS });
          onErrorRef.current?.(p);
          break;
        }
        case VOICE_S2C.sessionEnded: {
          // Thread-level exclusivity: another window took over the mic on this
          // thread. Revert cleanly to off and toast which window won, with no
          // reconnect (the server already ended it, so nothing to stop). Sent
          // direct to us; ignore it unless it ends the session we hold now (not
          // a stale one we replaced, nor an orphan while we hold none).
          const p = msg.payload as VoiceSessionEndedPayload;
          if (statusRef.current !== 'active') break;
          if (p.voiceSessionId && p.voiceSessionId !== voiceSessionIdRef.current) break;
          endSession(p.message || TAKEN_OVER_MESSAGE, { notifyServer: false });
          break;
        }
        default:
          break;
      }
    },
    [threadId, send, clearStartTimer, ensurePlayback, ensureEarcons, endSession, beginVoiceComposer]
  );

  useEffect(() => {
    const unsub = addMessageListener(handleFrame);
    return () => unsub();
  }, [addMessageListener, handleFrame]);

  const start = useCallback(() => {
    if (statusRef.current !== 'off') return;
    // The socket queues frames while disconnected, so this start would fire
    // whenever it reconnects — long after the user gave up. Say so instead.
    if (connectionStateRef.current !== 'open') {
      endSession(NOT_CONNECTED_MESSAGE);
      return;
    }
    statusRef.current = 'connecting';
    setStatus('connecting');
    setLastError(null);
    seqRef.current = 0;
    sessionModeRef.current = modeRef.current; // the mode the server is told this once
    // Record the (defaulted) flags this session is handshaken with — read by
    // the voice:final handler + the re-handshake effect below.
    sessionDictateRef.current = dictateOptRef.current ?? true;
    sessionSpeakRef.current = speakOptRef.current ?? true;
    const targets = targetsRef.current;
    const attachments = attachmentsRef.current;
    const requestId = newRequestId();
    pendingStartRef.current = requestId;
    send({
      type: VOICE_C2S.sessionStart,
      payload: {
        threadId,
        mode: modeRef.current,
        requestId,
        // Omit when the caller never passed them, like targetAgentIds and
        // attachmentImageIds below; the server treats an absent flag as `true`.
        ...(dictateOptRef.current !== undefined ? { dictate: dictateOptRef.current } : {}),
        ...(speakOptRef.current !== undefined ? { speak: speakOptRef.current } : {}),
        ...(targets.length ? { targetAgentIds: targets } : {}),
        ...(attachments.length ? { attachmentImageIds: attachments } : {}),
      } satisfies VoiceSessionStartPayload,
    });
    clearStartTimer();
    startTimerRef.current = setTimeout(() => {
      startTimerRef.current = null;
      if (statusRef.current === 'connecting') endSession(NO_ANSWER_MESSAGE);
    }, VOICE_START_TIMEOUT_MS);
  }, [send, threadId, clearStartTimer, endSession]);

  const stop = useCallback(() => {
    const sid = voiceSessionIdRef.current;
    if (sid) send({ type: VOICE_C2S.sessionStop, payload: { voiceSessionId: sid } });
    teardown();
    // A deliberate stop clears any earlier error.
    setLastError(null);
  }, [send, teardown]);

  const toggle = useCallback(() => {
    if (statusRef.current === 'off') start();
    else stop();
  }, [start, stop]);

  const pttPress = useCallback(() => {
    if (statusRef.current !== 'active' || capturingRef.current) return;
    const sid = voiceSessionIdRef.current;

    // Stash the user's typed draft at press time (before any partial overwrites
    // the composer) so it can be restored after the voice message dispatches.
    beginVoiceComposer();

    // Barge-in: cut the agent off, tell the server where we heard up to.
    if (playbackRef.current?.isSpeaking()) {
      const heard = playbackRef.current.flush();
      // Reconcile immediately — mirrors the same reconciliation on the
      // floor-resolution flush path (voice:floor handler, above). A straggler
      // ttsChunk for the flushed utterance that lands afterward is rejected by
      // PlaybackQueue's deadIds fence (enqueueChunk returns false), so it won't
      // resurrect these cleared entries.
      speakingIdsRef.current.clear();
      setAgentSpeaking(false);
      if (sid) {
        send({
          type: VOICE_C2S.bargein,
          payload: { voiceSessionId: sid, ...(heard ? { heardUpTo: heard } : {}) },
        });
      }
    }

    // The mic is hot for the whole session (see the mic-lifecycle effect); a
    // press only opens transmission; it never touches the device, so there's no
    // getUserMedia/AudioContext warm-up window to clip the first word into.
    // Flush the pre-roll ring first (the ~300 ms captured before the press) so
    // speech that started a breath early survives, then live chunks continue the
    // same per-utterance seq.
    seqRef.current = 0;
    if (sid) {
      for (const b64 of prerollRef.current) {
        send({
          type: VOICE_C2S.audioChunk,
          payload: {
            voiceSessionId: sid,
            seq: seqRef.current++,
            pcm16: b64,
            sampleRate: captureRateRef.current,
          },
        });
      }
    }
    prerollRef.current = [];
    capturingRef.current = true;
    setCapturing(true);
  }, [send, beginVoiceComposer]);

  const pttRelease = useCallback(() => {
    if (!capturingRef.current) return;
    capturingRef.current = false;
    setCapturing(false);
    // Release closes transmission only — the mic device stays hot for the
    // session (torn down on stop/unmount/mode-flip, not here).
    const sid = voiceSessionIdRef.current;
    if (sid) {
      awaitingFinalRef.current = true;
      send({
        type: VOICE_C2S.utteranceEnd,
        payload: {
          voiceSessionId: sid,
          // Esc-during-hold → finalize the text but suppress auto-dispatch.
          ...(bailPendingRef.current ? { cancelDispatch: true } : {}),
        },
      });
    }
  }, [send]);

  const requestBail = useCallback(() => {
    // Only meaningful while capturing or during the finalize beat.
    if (statusRef.current !== 'active') return;
    if (!capturingRef.current && !awaitingFinalRef.current) return;
    bailPendingRef.current = true;
    // Finalize beat: utterance:end already went out without the flag — send a
    // late cancel so the server can still suppress dispatch before it fires.
    if (!capturingRef.current && awaitingFinalRef.current) {
      const sid = voiceSessionIdRef.current;
      if (sid) {
        send({
          type: VOICE_C2S.utteranceEnd,
          payload: { voiceSessionId: sid, cancelDispatch: true },
        });
      }
    }
  }, [send]);

  // Live pill re-targeting (optional frame; also carried on session:start).
  const targetsKey = (opts.targetAgentIds ?? []).join(',');
  useEffect(() => {
    targetsRef.current = targetsKey ? targetsKey.split(',') : [];
    const sid = voiceSessionIdRef.current;
    if (sid) {
      send({
        type: VOICE_C2S.targetsSet,
        payload: {
          voiceSessionId: sid,
          targetAgentIds: targetsRef.current,
        } satisfies VoiceTargetsSetPayload,
      });
    }
  }, [targetsKey, send]);

  // Live attachment sync (same shape as pill re-targeting; also carried on
  // session:start). Keeps the server's pending-attachment set current so a
  // voice-dictated message includes whatever is attached at dispatch time —
  // including images added mid-utterance.
  const attachmentsKey = (opts.attachmentImageIds ?? []).join(',');
  useEffect(() => {
    attachmentsRef.current = attachmentsKey ? attachmentsKey.split(',') : [];
    const sid = voiceSessionIdRef.current;
    if (sid) {
      send({
        type: VOICE_C2S.attachmentsSet,
        payload: {
          voiceSessionId: sid,
          attachmentImageIds: attachmentsRef.current,
        } satisfies VoiceAttachmentsSetPayload,
      });
    }
  }, [attachmentsKey, send]);

  const activeMode = opts.mode ?? 'ptt';

  // Mode/flag flip re-handshake. The server learns the capture mode and the
  // dictate/speak flags only on voice:session:start, so a mid-session flip of
  // any of them would leave it on stale flags. Stop and start again with the
  // new combination; stop() discards any in-flight capture first.
  useEffect(() => {
    if (status !== 'active') return;
    const flagsChanged =
      activeMode !== sessionModeRef.current ||
      effectiveDictate !== sessionDictateRef.current ||
      effectiveSpeak !== sessionSpeakRef.current;
    if (!flagsChanged) return;
    stop();
    start();
  }, [status, activeMode, effectiveDictate, effectiveSpeak, stop, start]);

  // Hot mic: one device lifecycle per session, both modes. The mic opens when
  // the session goes active and runs until it ends, unmounts or re-handshakes.
  // PTT only toggles capturingRef, so no device warm-up clips the first word.
  // Chunk routing: open mode forwards every chunk; PTT held forwards live
  // chunks; PTT idle keeps the last VOICE_PREROLL_CHUNKS in the pre-roll ring.
  useEffect(() => {
    if (status !== 'active') return;
    // Guard the flip transient: stop() clears the session id before the
    // re-handshake completes — don't open a mic against a torn-down session.
    if (!voiceSessionIdRef.current) return;
    seqRef.current = 0;
    prerollRef.current = [];
    setMicReady(false);
    const mic = depsRef.current.createMic({
      onChunk: (b64, sampleRate) => {
        const s = voiceSessionIdRef.current;
        if (!s) return;
        captureRateRef.current = sampleRate;
        // Open-mic streams continuously; PTT gates on the hold.
        if (sessionModeRef.current === 'open' || capturingRef.current) {
          send({
            type: VOICE_C2S.audioChunk,
            payload: { voiceSessionId: s, seq: seqRef.current++, pcm16: b64, sampleRate },
          });
          return;
        }
        // PTT idle: ring the trailing pre-roll (bounded), forwarded on press.
        const ring = prerollRef.current;
        ring.push(b64);
        if (ring.length > VOICE_PREROLL_CHUNKS) ring.shift();
      },
      // One mic per session ⇒ a device error surfaces once, not once per press.
      onWarning: (err) => {
        const message = getErrorMessage(err, 'AudioWorklet unavailable');
        setLastError(`${COMPAT_CAPTURE_NOTICE}: ${message}`);
        showToast(COMPAT_CAPTURE_NOTICE, { durationMs: 3500 });
      },
      // Which mic is live (shown in the dock) + device-change surfacing so a
      // silent Continuity switch or a yanked device becomes visible.
      onDeviceLabel: (label) => setInputDevice(label),
      onDeviceChange: handleDeviceChange,
    });
    micRef.current = mic;
    // A server handshake without a live capture device is not a usable voice
    // session: on failure, or if startup never settles, end it so the UI cannot
    // claim it is listening and the user can retry after fixing the cause.
    micTimerRef.current = setTimeout(() => {
      micTimerRef.current = null;
      if (micRef.current === mic) endSession(MIC_TIMEOUT_MESSAGE);
    }, VOICE_MIC_START_TIMEOUT_MS);
    void mic
      .start()
      .then(() => {
        // Ignore completion from a capture object that was stopped/replaced
        // while getUserMedia was pending.
        if (micRef.current !== mic || !voiceSessionIdRef.current) return;
        clearMicTimer();
        setMicReady(true);
        // Capture works: drop this startup's compatibility notice, but keep a
        // real error visible (a warmup failure can land before the mic starts).
        setLastError((current) => (current?.startsWith(COMPAT_CAPTURE_NOTICE) ? null : current));
      })
      .catch((err) => {
        if (micRef.current !== mic) return;
        endSession(micErrorMessage(err));
      });
    return () => {
      clearMicTimer();
      mic.stop();
      setMicReady(false);
      if (micRef.current === mic) micRef.current = null;
      prerollRef.current = [];
    };
    // micNonce forces a rebuild after a yanked track; the callbacks are stable.
  }, [status, send, micNonce, handleDeviceChange, endSession, clearMicTimer]);

  // Tear the session down when the thread changes or the hook unmounts. Uses a
  // ref-read of the current session id so we don't recreate this effect per id.
  useEffect(() => {
    return () => {
      const sid = voiceSessionIdRef.current;
      if (sid) send({ type: VOICE_C2S.sessionStop, payload: { voiceSessionId: sid } });
      teardown();
    };
  }, [threadId, send, teardown]);

  const phase: VoicePhase = useMemo(() => {
    if (status === 'off') return 'off';
    if (status === 'connecting') return 'connecting';
    // Open-mic is always listening while active; agent speech takes visual
    // precedence over the ambient mic.
    if (activeMode === 'open') {
      if (agentSpeaking) return 'agent-speaking';
      return status === 'active' && micReady ? 'listening' : 'idle';
    }
    if (capturing) return 'listening';
    if (agentSpeaking) return 'agent-speaking';
    return 'idle';
  }, [status, capturing, agentSpeaking, activeMode, micReady]);

  return {
    phase,
    capturing,
    agentSpeaking,
    floorHolder,
    lastError,
    inputDevice,
    micReady,
    voiceSessionId,
    start,
    stop,
    toggle,
    pttPress,
    pttRelease,
    requestBail,
  };
}
