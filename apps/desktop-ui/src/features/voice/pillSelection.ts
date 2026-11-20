// Pure pill-selection logic: group default target = last agent who spoke;
// solo threads always auto-target the one agent. Kept dependency-free
// so it unit-tests without React or the api types — callers pass a minimal
// message shape.

/** Minimal message shape needed to find the last speaker. */
export interface SpeakerMessage {
  role: string;
  agentId: string | null;
}

/**
 * The most recent assistant message's agentId that is still a participant, or
 * null if no participant has spoken yet.
 */
// Exported for tests (pillSelection.test.ts); app code consumes
// defaultPillSelection below.
export function lastSpeakerAgentId(
  messages: ReadonlyArray<SpeakerMessage>,
  participantAgentIds: ReadonlyArray<string>
): string | null {
  const participants = new Set(participantAgentIds);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.agentId && participants.has(m.agentId)) {
      return m.agentId;
    }
  }
  return null;
}

/**
 * Default pill selection when the user hasn't touched the pills:
 *  - solo thread (≤1 participant) → auto-target that one agent;
 *  - group thread → the last agent who spoke (empty until someone has).
 */
export function defaultPillSelection(
  messages: ReadonlyArray<SpeakerMessage>,
  participantAgentIds: ReadonlyArray<string>
): string[] {
  if (participantAgentIds.length <= 1) return [...participantAgentIds];
  const last = lastSpeakerAgentId(messages, participantAgentIds);
  return last ? [last] : [];
}
