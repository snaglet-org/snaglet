import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { Button } from '@desktop/components';
import { getApiUrl } from '@desktop/utils/api/core';
import { getErrorMessage } from '@snaglet/shared/utils';
import { playOneShot } from '@desktop/features/voice/audio/playOneShot';
import { VOICE_SPEAK_MESSAGE_PATH } from '@desktop/features/voice/voiceConstants';
import {
  claimSpeaker,
  getSpeakerId,
  releaseSpeaker,
  stopSpeaker,
  subscribeSpeaker,
} from '@desktop/features/voice/oneShotSpeakerBus';
import styles from './MessageRow.module.scss';

interface BubbleActionsProps {
  messageId: string;
  content: string;
  /**
   * The message's agent, or null for a user message. The server resolves the
   * ▶ LISTEN voice from it (POST /voice/speak-message); null speaks in the
   * default voice, so re-listen is offered on every message.
   */
  agentId: string | null;
}

type SpeakStatus = 'idle' | 'loading' | 'speaking';

/**
 * Hover-revealed toolbar in the bubble footer: copy message id, copy raw
 * markdown, and re-listen. The parent `.row` shows it on hover.
 */
export const BubbleActions: FC<BubbleActionsProps> = ({ messageId, content, agentId }) => {
  const [flashId, setFlashId] = useState(false);
  const [flashText, setFlashText] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<SpeakStatus>(() =>
    getSpeakerId() === messageId ? 'speaking' : 'idle'
  );
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const flashIdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (flashIdTimer.current) clearTimeout(flashIdTimer.current);
      if (flashTextTimer.current) clearTimeout(flashTextTimer.current);
    };
  }, []);

  // One app-wide "currently speaking" slot (oneShotSpeakerBus): when another
  // message claims it, or it is stopped or released, this button reverts to
  // idle even though its own click handler never fired.
  useEffect(() => {
    return subscribeSpeaker((speakingId) => {
      if (speakingId !== messageId) {
        setVoiceStatus((prev) => (prev === 'idle' ? prev : 'idle'));
      }
    });
  }, [messageId]);

  const handleCopyId = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(messageId);
    } catch {
      return; // write failed — don't flash a false "COPIED"
    }
    setFlashId(true);
    if (flashIdTimer.current) clearTimeout(flashIdTimer.current);
    flashIdTimer.current = setTimeout(() => setFlashId(false), 1200);
  }, [messageId]);

  const handleCopyContent = useCallback(async () => {
    const text = content.trim();
    if (!text) return; // nothing to copy — don't confirm an empty copy
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setFlashText(true);
    if (flashTextTimer.current) clearTimeout(flashTextTimer.current);
    flashTextTimer.current = setTimeout(() => setFlashText(false), 1200);
  }, [content]);

  // Re-listen works with voice mode off: it calls the standalone
  // /voice/speak-message route, never useVoiceSession or the live socket.
  const handleListen = useCallback(async () => {
    if (voiceStatus === 'speaking') {
      stopSpeaker(); // this message is the current speaker: a second click stops it
      return;
    }
    const text = content.trim();
    if (!text) return; // nothing to speak

    setVoiceStatus('loading');
    setVoiceError(null);
    try {
      const res = await fetch(getApiUrl(VOICE_SPEAK_MESSAGE_PATH), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // agentId omitted (undefined) for a user message — the server falls
        // back to the default voice, same as an agentId that resolves to none.
        body: JSON.stringify({ agentId: agentId ?? undefined, text }),
      });
      if (!res.ok) throw new Error(`speak failed (${res.status})`);
      const wav = await res.arrayBuffer();
      const handle = await playOneShot(wav, () => {
        releaseSpeaker(messageId);
        setVoiceStatus('idle');
      });
      claimSpeaker(messageId, handle); // stops whichever other message was speaking
      setVoiceStatus('speaking');
    } catch (err) {
      setVoiceStatus('idle');
      setVoiceError(getErrorMessage(err, 'Playback failed'));
    }
  }, [voiceStatus, content, agentId, messageId]);

  const speaking = voiceStatus === 'speaking';
  // The name says what the button does; a playback failure rides the title,
  // which becomes the button's description, instead of replacing the name.
  const listenLabel = speaking ? 'Stop' : 'Listen';

  return (
    <div className={styles.bubbleActions}>
      <Button
        variant="ghost"
        size="xs"
        className={styles.bubbleActionButton}
        onClick={handleCopyId}
        title={flashId ? 'Copied' : 'Copy message ID'}
        aria-label={flashId ? 'Copied' : 'Copy message ID'}
      >
        {flashId ? 'COPIED' : '#ID'}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className={styles.bubbleActionButton}
        onClick={handleCopyContent}
        title={flashText ? 'Copied' : 'Copy message text'}
        aria-label={flashText ? 'Copied' : 'Copy message text'}
      >
        {flashText ? 'COPIED' : 'COPY'}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className={styles.bubbleActionButton}
        aria-pressed={speaking}
        onClick={() => void handleListen()}
        loading={voiceStatus === 'loading'}
        loadingText="…"
        disabled={!content.trim()}
        title={voiceError ? `Couldn’t play this message: ${voiceError}` : listenLabel}
        aria-label={listenLabel}
      >
        {speaking ? '■ STOP' : '▶ LISTEN'}
      </Button>
    </div>
  );
};
