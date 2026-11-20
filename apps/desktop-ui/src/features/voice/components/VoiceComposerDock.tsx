// Voice errors that sit just above the composer while voice mode is live.
// Recipient pills are a separate composer-level control because the same
// selection routes typed and spoken messages.
// Theme tokens only.

import { type FC, type CSSProperties } from 'react';
import { useVoiceSessionContext } from '../VoiceSessionContext';
import { VoiceFirstUsePrompt } from './VoiceFirstUsePrompt';

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.5rem 0.25rem',
};

export const VoiceComposerDock: FC = () => {
  const ctx = useVoiceSessionContext();
  if (!ctx) return null;

  // The first-use download prompt shows before a session is live (it's what
  // gates starting one), so it can't hang off `isOn`.
  const showPrompt = ctx.firstUsePrompt !== null;
  const lastError = ctx.isOn ? ctx.api.lastError : null;
  if (!showPrompt && !lastError) return null;

  return (
    <div style={wrap} data-testid="voice-composer-dock">
      {showPrompt && <VoiceFirstUsePrompt />}
      {lastError && (
        <div
          role="alert"
          style={{ fontSize: '0.75rem', color: 'var(--color-error)' }}
          data-testid="voice-error"
        >
          {lastError}
        </div>
      )}
    </div>
  );
};
