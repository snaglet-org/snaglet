// VoiceSessionProvider — composes the voice session (useVoiceSession) with the
// thread's dispatch mode and the composer pill selection, and shares them
// via context so the composer's Dictation and Voice-mode buttons and the voice
// dock read one source of truth. Follows the UI convention of context (no
// Redux/Zustand).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useVoiceSession, type VoiceSessionApi } from './useVoiceSession';
import { useThreadDispatchMode, type DispatchMode } from './useThreadDispatchMode';
import { subscribeVoiceAttachmentIds, getVoiceAttachmentIds } from './voiceAttachmentsBus';
import { useThreadRecipientContext } from './ThreadRecipientContext';
import { snagletHomeApi, type VoiceModelState } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';

// Exported for tests (VoiceSessionContext.test.tsx); app code reaches the
// value through useVoiceSessionContext().
export interface VoiceSessionContextValue {
  api: VoiceSessionApi;
  /** Session is live (past the handshake). */
  isOn: boolean;
  /**
   * Two independent button states, each driving its own flag on the one
   * underlying session (the server holds one voice session per WS client).
   *   - `dictateOn`: the Dictation button (mic icon). The transcript lands in
   *     the composer as a draft and is never auto-sent.
   *   - `speakOn`: the Voice mode button (waveform icon). Agent replies are
   *     spoken aloud; it also implies dictation (see `effectiveDictate`).
   */
  dictateOn: boolean;
  speakOn: boolean;
  /** Voice permitted for this routing mode. All current routing modes support voice. */
  dispatchAllowed: boolean;
  /** Reason voice is blocked (for the toggle tooltip), or null when allowed. */
  blockedReason: string | null;
  /** Flip `dictateOn`. Guarded only against a routing mode without voice. */
  toggleDictate: () => void;
  /** Flip `speakOn` (and, via `effectiveDictate`, dictation along with it). */
  toggleSpeak: () => void;
  /**
   * First-use model gate. Turning voice on without the local models installed
   * opens this prompt instead of starting a session. `null` when no prompt is
   * showing; otherwise the live download state drives the prompt's buttons and
   * progress text.
   */
  firstUsePrompt: VoiceModelState | null;
  /** Start (or join) the in-app model download from the first-use prompt. */
  confirmFirstUseDownload: () => void;
  /** Dismiss the first-use prompt ("Not now") without starting voice. */
  dismissFirstUsePrompt: () => void;
}

const VoiceSessionContext = createContext<VoiceSessionContextValue | null>(null);

const VOICE_SUPPORTED_DISPATCH_MODES: ReadonlySet<DispatchMode> = new Set(['all', 'mentioned']);

/**
 * Is `kind` ready to start from this status response? Prefer the per-mode
 * capability report (so macOS Dictation — Apple speech, no local model — is
 * ready with nothing downloaded); falls back to the global `state` when the
 * response has no capabilities.
 */
function modeReadyFromStatus(state: VoiceModelState, kind: 'dictate' | 'speak'): boolean {
  const cap = state.capabilities?.[kind];
  return cap ? cap.ready : state.state === 'ready';
}

export interface VoiceSessionProviderProps {
  threadId: string;
  children: ReactNode;
}

export function VoiceSessionProvider({ threadId, children }: VoiceSessionProviderProps) {
  const recipients = useThreadRecipientContext();
  if (!recipients) {
    throw new Error('VoiceSessionProvider requires ThreadRecipientProvider');
  }
  const { selectedAgentIds } = recipients;
  const dispatchMode = useThreadDispatchMode(threadId);
  // Routing controls which agents run, not whether voice is available. The
  // server's per-thread voice floor still serializes generation/playback so
  // enabling All mode cannot make agents speak over one another. Unknown while
  // the fetch resolves is allowed so a slow request never blocks the toggle.
  const dispatchAllowed = dispatchMode == null || VOICE_SUPPORTED_DISPATCH_MODES.has(dispatchMode);
  const blockedReason = dispatchAllowed ? null : 'Voice is unavailable for this routing mode.';

  // The composer publishes its current image attachments here (voiceAttachmentsBus);
  // we mirror them so the voice session carries them (session:start +
  // voice:attachments:set) and a voice-dictated message includes the user's
  // attachments. Seeded via the retained getter so we never miss the composer's
  // mount publish (effects run child-first).
  const [attachmentImageIds, setAttachmentImageIds] = useState<string[]>(() =>
    getVoiceAttachmentIds(threadId)
  );
  useEffect(() => {
    const unsub = subscribeVoiceAttachmentIds((evt) => {
      if (evt.threadId !== threadId) return;
      setAttachmentImageIds(evt.attachmentIds);
    });
    setAttachmentImageIds(getVoiceAttachmentIds(threadId));
    return unsub;
  }, [threadId]);

  // Two independent button states. Voice mode implies dictation too (see
  // `effectiveDictate`): a spoken conversation needs a mic to talk back with.
  // The Dictation button alone stays speak-independent.
  const [dictateOn, setDictateOn] = useState(false);
  const [speakOn, setSpeakOn] = useState(false);
  const effectiveDictate = dictateOn || speakOn;
  const effectiveSpeak = speakOn;

  // First-use model gate. Readiness is cached per mode, because the modes need
  // different components: on macOS, Dictation uses Apple's recognizer and needs
  // no local model, while Voice mode still needs VAD and TTS. `pendingKind`
  // remembers which toggle was pressed so a finished download turns that one
  // on (starting the session re-reads the models from disk).
  const [modeReady, setModeReady] = useState<{ dictate: boolean; speak: boolean }>({
    dictate: false,
    speak: false,
  });
  const [firstUsePrompt, setFirstUsePrompt] = useState<VoiceModelState | null>(null);
  const [pendingKind, setPendingKind] = useState<'dictate' | 'speak' | null>(null);

  // The session can end without either button being pressed: the server
  // refused or never answered the start, the mic would not start, another
  // window took over. The user has been told why; turn both buttons off so the
  // effect below doesn't restart the failed session over and over (and two
  // windows don't keep taking the mic from each other).
  const handleEnded = useCallback(() => {
    setDictateOn(false);
    setSpeakOn(false);
  }, []);

  const api = useVoiceSession(threadId, {
    // Release surface has one capture path: continuous open mic + server VAD.
    // Dictation vs Voice mode is expressed by dictate/speak, not capture mode.
    mode: 'open',
    dictate: effectiveDictate,
    speak: effectiveSpeak,
    targetAgentIds: selectedAgentIds,
    attachmentImageIds,
    onEnded: handleEnded,
  });

  const isOn = api.phase !== 'off' && api.phase !== 'connecting';

  // Drive the one underlying session from the two button states: start once
  // either wants it, stop once neither does. A flag change while active is
  // handled by useVoiceSession's re-handshake effect, not here.
  useEffect(() => {
    const wantActive = effectiveDictate || effectiveSpeak;
    if (wantActive && api.phase === 'off') api.start();
    else if (!wantActive && api.phase !== 'off') api.stop();
  }, [effectiveDictate, effectiveSpeak, api.phase, api.start, api.stop]);

  // Turning voice on needs the local models. Check once: installed → proceed;
  // missing → open the first-use prompt and don't start the session yet. A
  // failed status read counts as present, so a flaky check never blocks a user
  // (the session start reports a real missing-model error itself).
  const gateOrStart = useCallback(
    (kind: 'dictate' | 'speak', start: () => void) => {
      if (modeReady[kind]) {
        start();
        return;
      }
      setPendingKind(kind);
      void snagletHomeApi.voiceModels
        .get()
        .then((state) => {
          // Gate on what this mode needs for the active engine, not the global
          // install state: macOS Dictation (Apple speech) needs no local model,
          // so it starts immediately with nothing downloaded.
          if (modeReadyFromStatus(state, kind)) {
            setModeReady((prev) => ({ ...prev, [kind]: true }));
            setPendingKind(null);
            start();
          } else {
            setFirstUsePrompt(state);
          }
        })
        .catch((err: unknown) => {
          console.error('[voice] model status check failed:', getErrorMessage(err));
          setModeReady((prev) => ({ ...prev, [kind]: true }));
          setPendingKind(null);
          start();
        });
    },
    [modeReady]
  );

  const toggleDictate = useCallback(() => {
    if (!dispatchAllowed && !dictateOn) return;
    if (dictateOn) {
      setDictateOn(false);
      return;
    }
    gateOrStart('dictate', () => setDictateOn(true));
  }, [dispatchAllowed, dictateOn, gateOrStart]);

  const toggleSpeak = useCallback(() => {
    if (!dispatchAllowed && !speakOn) return;
    if (speakOn) {
      setSpeakOn(false);
      return;
    }
    gateOrStart('speak', () => setSpeakOn(true));
  }, [dispatchAllowed, speakOn, gateOrStart]);

  // Download from the prompt. A second press joins the running install (the
  // server owns one install process-wide); poll until it settles, then — on
  // success — flip the pending toggle on so voice starts with no restart.
  const confirmFirstUseDownload = useCallback(() => {
    setFirstUsePrompt((prev) =>
      prev && prev.state === 'downloading' ? prev : { state: 'downloading' }
    );
    void snagletHomeApi.voiceModels
      .install()
      .then((result) => {
        // Install answers 202 with 'downloading' and the poll effect below
        // settles it; an immediate 'ready' is handled here too.
        setFirstUsePrompt(result);
        if (result.state === 'ready') {
          setModeReady({ dictate: true, speak: true });
          setFirstUsePrompt(null);
          if (pendingKind === 'speak') setSpeakOn(true);
          else if (pendingKind === 'dictate') setDictateOn(true);
          setPendingKind(null);
        }
      })
      .catch((err: unknown) => {
        setFirstUsePrompt({
          state: 'failed',
          error: getErrorMessage(err, 'Voice model download failed'),
        });
      });
  }, [pendingKind]);

  // Poll progress while the prompt download is running so the bar advances and
  // a server-side completion (e.g. a parallel install) resolves the prompt.
  useEffect(() => {
    if (firstUsePrompt?.state !== 'downloading') return;
    const timer = window.setInterval(() => {
      void snagletHomeApi.voiceModels
        .get()
        .then((state) => {
          // The pending mode is settled once its needs are met; the poll's own
          // 1s cadence is what settles the 202 install response.
          const pendingReady = pendingKind ? modeReadyFromStatus(state, pendingKind) : false;
          if (state.state === 'ready' || pendingReady) {
            setModeReady((prev) => ({
              dictate: prev.dictate || modeReadyFromStatus(state, 'dictate'),
              speak: prev.speak || modeReadyFromStatus(state, 'speak'),
            }));
            setFirstUsePrompt(null);
            if (pendingKind === 'speak') setSpeakOn(true);
            else if (pendingKind === 'dictate') setDictateOn(true);
            setPendingKind(null);
          } else if (state.state !== 'not-installed') {
            setFirstUsePrompt(state);
          }
        })
        .catch((err: unknown) => {
          console.error('[voice] first-use download poll failed:', getErrorMessage(err));
        });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [firstUsePrompt?.state, pendingKind]);

  const dismissFirstUsePrompt = useCallback(() => {
    setFirstUsePrompt(null);
    setPendingKind(null);
  }, []);

  const value = useMemo<VoiceSessionContextValue>(
    () => ({
      api,
      isOn,
      dictateOn,
      speakOn,
      dispatchAllowed,
      blockedReason,
      toggleDictate,
      toggleSpeak,
      firstUsePrompt,
      confirmFirstUseDownload,
      dismissFirstUsePrompt,
    }),
    [
      api,
      isOn,
      dictateOn,
      speakOn,
      dispatchAllowed,
      blockedReason,
      toggleDictate,
      toggleSpeak,
      firstUsePrompt,
      confirmFirstUseDownload,
      dismissFirstUsePrompt,
    ]
  );

  return <VoiceSessionContext.Provider value={value}>{children}</VoiceSessionContext.Provider>;
}

/** Read the voice session; null outside a provider (voice UI simply hides). */
export function useVoiceSessionContext(): VoiceSessionContextValue | null {
  return useContext(VoiceSessionContext);
}
