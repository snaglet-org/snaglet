import { buildDispatchSet } from '@server/services/SocketService/handlers/chatHandlers/buildDispatchSet';
import type { MentionResult } from '@server/services/MentionParser';

function mentions(ids: string[]): MentionResult {
  return {
    mentionedAgentIds: ids,
    hasMentions: ids.length > 0,
    rawMentions: ids.map((id) => `@${id}`),
  };
}

describe('buildDispatchSet', () => {
  const participants = ['agent-a', 'agent-b', 'agent-c'];

  it('dispatches everyone in all mode even when explicit mentions are present', () => {
    const result = buildDispatchSet({
      mentions: mentions(['agent-b']),
      dispatchRouting: 'all',
      participantAgentIds: participants,
      mentionedIdSetLC: new Set(['agent-b']),
    });

    expect([...result]).toEqual(participants);
  });

  it('narrows explicit mentions in mentioned mode', () => {
    const result = buildDispatchSet({
      mentions: mentions(['agent-b']),
      dispatchRouting: 'mentioned',
      participantAgentIds: participants,
      mentionedIdSetLC: new Set(['agent-b']),
    });

    expect([...result]).toEqual(['agent-b']);
  });

  it('matches mention IDs case-insensitively while preserving participant casing', () => {
    const result = buildDispatchSet({
      mentions: mentions(['AGENT-B']),
      dispatchRouting: 'mentioned',
      participantAgentIds: ['agent-a', 'Agent-B'],
      mentionedIdSetLC: new Set(['agent-b']),
    });

    expect([...result]).toEqual(['Agent-B']);
  });

  // Product contract: 'mentioned' mode group threads require an explicit
  // @mention. Without one, the dispatch set is empty so the caller can surface
  // a hint. Silence until addressed is the correct behavior for this mode.
  it('returns empty in mentioned mode for a group thread when there are no mentions', () => {
    const result = buildDispatchSet({
      mentions: mentions([]),
      dispatchRouting: 'mentioned',
      participantAgentIds: participants,
      mentionedIdSetLC: new Set(),
    });

    expect([...result]).toEqual([]);
  });

  // Single-agent thread: no @mention needed even in 'mentioned' mode.
  it('dispatches to the sole participant in mentioned mode with no mentions', () => {
    const result = buildDispatchSet({
      mentions: mentions([]),
      dispatchRouting: 'mentioned',
      participantAgentIds: ['agent-a'],
      mentionedIdSetLC: new Set(),
    });

    expect([...result]).toEqual(['agent-a']);
  });

  // 'all' mode with no mentions still wakes everyone.
  it('dispatches to everyone in all mode when there are no mentions', () => {
    const result = buildDispatchSet({
      mentions: mentions([]),
      dispatchRouting: 'all',
      participantAgentIds: participants,
      mentionedIdSetLC: new Set(),
    });

    expect([...result]).toEqual(participants);
  });
});
