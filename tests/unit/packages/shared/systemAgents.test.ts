import { describe, expect, it } from '@jest/globals';
import {
  GHOST_AGENT_ID,
  GHOST_HOOK_LABEL,
  isReservedActorName,
  readOriginalAgentName,
  resolveAuthorLabel,
} from '@snaglet/shared/constants/systemAgents';

describe('GHOST_HOOK_LABEL', () => {
  it('is the plain word "system"', () => {
    expect(GHOST_HOOK_LABEL).toBe('system');
  });
});

describe('resolveAuthorLabel', () => {
  it('ghost with no originalAgentName stamp reads as the hook label', () => {
    expect(resolveAuthorLabel({ agentId: GHOST_AGENT_ID, fallbackName: 'ghost' })).toBe('system');
    expect(
      resolveAuthorLabel({
        agentId: GHOST_AGENT_ID,
        fallbackName: 'ghost',
        originalAgentName: null,
      })
    ).toBe('system');
    expect(
      resolveAuthorLabel({
        agentId: GHOST_AGENT_ID,
        fallbackName: 'ghost',
        originalAgentName: '  ',
      })
    ).toBe('system');
  });

  it("ghost with a stamp (a deleted agent's message) keeps the normal name", () => {
    expect(
      resolveAuthorLabel({
        agentId: GHOST_AGENT_ID,
        fallbackName: 'ghost',
        originalAgentName: 'Bill',
      })
    ).toBe('ghost');
  });

  it('a non-ghost author keeps the normal name, stamp or not', () => {
    expect(resolveAuthorLabel({ agentId: 'agent-1', fallbackName: 'Venus' })).toBe('Venus');
    expect(
      resolveAuthorLabel({ agentId: 'agent-1', fallbackName: 'Venus', originalAgentName: 'x' })
    ).toBe('Venus');
    expect(resolveAuthorLabel({ agentId: null, fallbackName: 'agent' })).toBe('agent');
    expect(resolveAuthorLabel({ agentId: undefined, fallbackName: null })).toBeNull();
  });
});

describe('readOriginalAgentName', () => {
  it('reads the purge stamp, and is null for anything else', () => {
    expect(readOriginalAgentName({ originalAgentName: 'Bill' })).toBe('Bill');
    expect(readOriginalAgentName({})).toBeNull();
    expect(readOriginalAgentName(null)).toBeNull();
    expect(readOriginalAgentName('x')).toBeNull();
    expect(readOriginalAgentName({ originalAgentName: 5 })).toBeNull();
    expect(readOriginalAgentName({ originalAgentName: '' })).toBeNull();
  });
});

describe('isReservedActorName', () => {
  it('reserves both "ghost" and the "system" hook label, trimmed and case-insensitive', () => {
    for (const n of ['ghost', 'Ghost', 'system', 'SYSTEM', '  System  ']) {
      expect(isReservedActorName(n)).toBe(true);
    }
  });

  it('does not reserve ordinary names', () => {
    for (const n of ['Venus', 'systems', 'ghosty', '', null, undefined]) {
      expect(isReservedActorName(n)).toBe(false);
    }
  });
});
