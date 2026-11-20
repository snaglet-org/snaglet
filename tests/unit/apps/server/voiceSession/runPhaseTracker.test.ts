/**
 * runPhaseTracker + utteranceEvents + runStatusEvents.
 *
 * The barge-in phase signal is bound to the real run status
 * (socket:agent:status → runStatusEvents), not inferred from utterances.
 * Verifies: tool_running marks the specific agent mid-tool; thinking/typing/idle
 * clear it; per-agent precision; the voice-active guard; and the utteranceEvents
 * kind derivation (still used by the TTS pipeline).
 */

import {
  emitUtterancePersisted,
  onUtterancePersisted,
  __resetUtteranceListeners,
  type UtterancePersistedEvent,
} from '@server/services/SocketService/voiceSession/utteranceEvents';
import {
  emitRunStatus,
  __resetRunStatusListeners,
} from '@server/services/SocketService/voiceSession/runStatusEvents';
import {
  initRunPhaseTracker,
  isToolInFlight,
  clearRunPhase,
  __resetRunPhaseTracker,
} from '@server/services/SocketService/voiceSession/runPhaseTracker';
import {
  markThreadVoiceActive,
  unmarkThreadVoiceActive,
  __resetVoiceRegistry,
} from '@server/services/SocketService/voiceSession/voiceSessionRegistry';

const THREAD = 'thread-1';
const CLIENT = 'client-1';

afterEach(() => {
  __resetRunPhaseTracker();
  __resetRunStatusListeners();
  __resetUtteranceListeners();
  __resetVoiceRegistry();
});

describe('utteranceEvents kind derivation', () => {
  function emit(kindFields: { hasUsage: boolean; logLabel: string }) {
    emitUtterancePersisted({
      threadId: THREAD,
      agentId: 'A',
      runId: 'run1',
      messageId: 'm1',
      content: 'hi',
      ...kindFields,
    });
  }

  it('derives interim / terminal / partial-abort from usage + logLabel', () => {
    const seen: UtterancePersistedEvent[] = [];
    onUtterancePersisted((e) => seen.push(e));
    emit({ hasUsage: false, logLabel: 'interim utterance persisted' });
    emit({ hasUsage: true, logLabel: 'assistant message' });
    emit({ hasUsage: false, logLabel: 'partial utterance persisted (aborted mid-utterance)' });
    expect(seen.map((e) => e.kind)).toEqual(['interim', 'terminal', 'partial-abort']);
  });

  it('a throwing listener never breaks the emit', () => {
    onUtterancePersisted(() => {
      throw new Error('boom');
    });
    expect(() => emit({ hasUsage: false, logLabel: 'interim utterance persisted' })).not.toThrow();
  });
});

describe('runPhaseTracker (run-status driven)', () => {
  beforeEach(() => {
    initRunPhaseTracker();
    // runPhaseTracker's guard is isThreadVoiceActive, speak-scoped: barge-in
    // phase tracking is about the speaking side (which agent is mid-tool while
    // its reply would otherwise be voiced), so mark this client as a `speak`
    // session, not `dictate`.
    markThreadVoiceActive(THREAD, CLIENT, { dictate: false, speak: true });
  });

  it('marks tool-in-flight on tool_running and clears on the next thinking', () => {
    expect(isToolInFlight(THREAD)).toBe(false);
    emitRunStatus({ threadId: THREAD, agentId: 'A', status: 'tool_running' });
    expect(isToolInFlight(THREAD)).toBe(true);
    expect(isToolInFlight(THREAD, 'A')).toBe(true);
    emitRunStatus({ threadId: THREAD, agentId: 'A', status: 'thinking' });
    expect(isToolInFlight(THREAD)).toBe(false);
  });

  it('typing and idle also clear the flag', () => {
    emitRunStatus({ threadId: THREAD, agentId: 'A', status: 'tool_running' });
    emitRunStatus({ threadId: THREAD, agentId: 'A', status: 'typing' });
    expect(isToolInFlight(THREAD, 'A')).toBe(false);
    emitRunStatus({ threadId: THREAD, agentId: 'A', status: 'tool_running' });
    emitRunStatus({ threadId: THREAD, agentId: 'A', status: 'idle' });
    expect(isToolInFlight(THREAD, 'A')).toBe(false);
  });

  it('tracks phase per agent (group precision)', () => {
    emitRunStatus({ threadId: THREAD, agentId: 'A', status: 'tool_running' });
    emitRunStatus({ threadId: THREAD, agentId: 'B', status: 'thinking' });
    expect(isToolInFlight(THREAD, 'A')).toBe(true);
    expect(isToolInFlight(THREAD, 'B')).toBe(false);
    // Any-agent form is true while A is mid-tool.
    expect(isToolInFlight(THREAD)).toBe(true);
  });

  it('ignores status for threads with no active voice session', () => {
    unmarkThreadVoiceActive(THREAD, CLIENT);
    emitRunStatus({ threadId: THREAD, agentId: 'A', status: 'tool_running' });
    expect(isToolInFlight(THREAD, 'A')).toBe(false);
  });

  it('clearRunPhase drops a thread', () => {
    emitRunStatus({ threadId: THREAD, agentId: 'A', status: 'tool_running' });
    clearRunPhase(THREAD);
    expect(isToolInFlight(THREAD, 'A')).toBe(false);
  });
});
