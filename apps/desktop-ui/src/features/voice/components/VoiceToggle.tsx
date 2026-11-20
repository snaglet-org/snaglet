// Dictation on/off toggle: the plain mic icon in the composer's secondary rail.
// The transcript lands in the composer as an editable draft and is never
// auto-sent. Independent of Voice mode (VoiceModeToggle); either can be on
// alone. A square icon button on the shared Button component, matching the
// composer's attach/send chrome. Disabled only for a dispatch mode without
// voice support. Theme tokens only.

import { type FC, type CSSProperties } from 'react';
import { Button } from '@desktop/components';
import { MicIcon } from '@desktop/components/Icons';
import { useVoiceSessionContext } from '../VoiceSessionContext';

function labelFor(phase: string): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting…';
    // Open mic is 'idle' only while the session is live but the microphone
    // has not started yet (getUserMedia / permission prompt).
    case 'idle':
      return 'Starting microphone…';
    case 'listening':
      return 'Recording';
    default:
      return 'Dictation on';
  }
}

// Connecting and mic startup pulse the glyph. Everything else leans on the
// Button variant color (ghost=off, primary=on). Dictation never triggers
// agent-speaking (a dictate-only session never registers a TTS sink), so no
// speaking halo here.
function glowStyle(phase: string): CSSProperties {
  const style: CSSProperties = {};
  if (phase === 'connecting' || phase === 'idle') {
    style.animation = 'snagletVoicePulse 1.1s ease-in-out infinite';
  }
  return style;
}

export const VoiceToggle: FC = () => {
  const ctx = useVoiceSessionContext();
  if (!ctx) return null;

  const { api, dictateOn, dispatchAllowed, blockedReason, toggleDictate } = ctx;
  const { phase, inputDevice, lastError } = api;
  const disabled = !dispatchAllowed && !dictateOn;

  // Off after a failure: keep the reason on hover (the toast fades).
  const offTitle =
    lastError && phase === 'off'
      ? `${lastError} — click to try again`
      : 'Turn on dictation: record, edit, and send manually';
  const baseTitle = disabled
    ? (blockedReason ?? 'Voice unavailable in this thread')
    : !dictateOn
      ? offTitle
      : `${labelFor(phase)} — click to turn off dictation`;
  // Surface the live input device on hover.
  const title = inputDevice && !disabled ? `${baseTitle} · Mic: ${inputDevice}` : baseTitle;

  return (
    <Button
      variant={disabled || !dictateOn ? 'ghost' : 'primary'}
      size="md"
      iconOnly
      aria-pressed={dictateOn}
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={toggleDictate}
      data-testid="voice-toggle"
      data-phase={phase}
      style={glowStyle(phase)}
    >
      {/* Keyframes are inline so this component needs no .scss file. */}
      <style>{'@keyframes snagletVoicePulse{0%,100%{opacity:1}50%{opacity:0.45}}'}</style>
      <MicIcon />
    </Button>
  );
};
