// Voice mode on/off toggle: the waveform icon in the composer's secondary rail.
// Starts or stops a hands-free spoken conversation. Turns on `speak` (agent
// replies spoken aloud) and, via VoiceSessionContext's `effectiveDictate`,
// `dictate` too. Independent of the Dictation toggle (VoiceToggle), which can
// dictate without speak. Capture is always open mic with server VAD.

import { type FC } from 'react';
import { Button } from '@desktop/components';
import { WaveformIcon } from '@desktop/components/Icons';
import { useVoiceSessionContext } from '../VoiceSessionContext';

export const VoiceModeToggle: FC = () => {
  const ctx = useVoiceSessionContext();
  if (!ctx) return null;

  const { api, speakOn, dispatchAllowed, blockedReason, toggleSpeak } = ctx;
  const phase = api.phase;
  const disabled = !dispatchAllowed && !speakOn;

  const title = disabled
    ? (blockedReason ?? 'Voice mode unavailable in this thread')
    : !speakOn
      ? 'Turn on voice mode: agent replies are spoken aloud'
      : phase === 'agent-speaking'
        ? 'Speaking — click to turn off voice mode'
        : phase === 'connecting'
          ? 'Connecting… — click to turn off voice mode'
          : 'Voice mode on — click to turn off';

  return (
    <div
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}
      data-testid="voice-mode-cluster"
    >
      <Button
        variant={disabled || !speakOn ? 'ghost' : 'primary'}
        size="md"
        iconOnly
        aria-pressed={speakOn}
        aria-label={title}
        title={title}
        disabled={disabled}
        onClick={toggleSpeak}
        data-testid="voice-mode-button"
        data-phase={phase}
      >
        <WaveformIcon />
      </Button>
    </div>
  );
};
