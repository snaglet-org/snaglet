// Multi-select recipient pills in the composer area for group threads.
// One thread-scoped selection drives both typed and voice sends. The current
// voice:floor holder still glows when a voice session is active.

import { type FC, type CSSProperties } from 'react';
import { SpeakerIcon } from '@desktop/components/Icons';
import { useVoiceSessionContext } from '../VoiceSessionContext';
import { useThreadRecipientContext } from '../ThreadRecipientContext';

const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.35rem',
  alignItems: 'center',
};

function pillStyle(selected: boolean, glow: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    padding: '0.15rem 0.6rem',
    borderRadius: '999px',
    border: `1px solid ${selected ? 'var(--color-primary-border)' : 'var(--color-border)'}`,
    background: selected ? 'var(--color-primary-bg)' : 'var(--color-background)',
    color: selected ? 'var(--color-primary-on-selected)' : 'var(--color-text-muted)',
    font: 'inherit',
    fontSize: '0.75rem',
    cursor: 'pointer',
    ...(glow ? { boxShadow: '0 0 0 2px var(--color-primary-muted)' } : {}),
  };
}

export const AgentPillsRow: FC = () => {
  const recipients = useThreadRecipientContext();
  const voice = useVoiceSessionContext();
  if (!recipients) return null;
  const { participantAgentIds, selectedAgentIds, toggleAgent, agentName } = recipients;
  if (participantAgentIds.length <= 1) return null;

  const floorHolder = voice?.api.floorHolder ?? null;

  return (
    <div
      style={rowStyle}
      role="group"
      aria-label="Message recipients"
      data-testid="agent-recipient-pills"
    >
      <span style={{ fontSize: '0.72rem', color: 'var(--color-text-subtle)' }}>To:</span>
      {participantAgentIds.map((id) => {
        const selected = selectedAgentIds.includes(id);
        const glow = floorHolder === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            title={glow ? `${agentName(id)} — speaking now` : `Message ${agentName(id)}`}
            style={pillStyle(selected, glow)}
            onClick={() => toggleAgent(id)}
            data-agent-id={id}
            data-selected={selected}
            data-speaking={glow}
          >
            {glow && <SpeakerIcon />}
            <span>{agentName(id)}</span>
          </button>
        );
      })}
    </div>
  );
};
