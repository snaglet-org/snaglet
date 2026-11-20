/**
 * buildAutomationWakeNote — the turn-context note for a turn an automation
 * started: present only for the agent the automation wakes, naming who
 * scheduled it, and left out when there is no wake marker or the lookup fails.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindById = jest.fn<(id: string) => Promise<Record<string, unknown> | null>>();
jest.mock('@snaglet/db/tables/automations', () => ({
  Automations: { findById: (id: string) => mockFindById(id) },
}));
const mockWarn = jest.fn();
jest.mock('@server/config/logger', () => ({ logger: { warn: (m: unknown) => mockWarn(m) } }));

import { buildAutomationWakeNote } from '@server/services/SocketService/handlers/chatPhases/buildAutomationWakeNote';

const ID = 'automation-1111111111111-aaaaaaaaa';
const WAKE = { kind: 'automation', automationId: ID } as const;

beforeEach(() => {
  mockFindById.mockReset().mockResolvedValue({
    id: ID,
    name: 'Check backlog',
    agentId: 'test-agent-a',
    createdByAgentId: 'test-agent-a',
  });
});

describe('buildAutomationWakeNote', () => {
  it('tells the woken agent the automation it scheduled started this turn', async () => {
    const note = await buildAutomationWakeNote(WAKE, 'test-agent-a');
    expect(mockFindById).toHaveBeenCalledWith(ID);
    expect(note).toContain('started by the automation "Check backlog" (scheduled by you)');
    expect(note).toContain('not by someone typing, and nobody is waiting live');
    expect(note).toContain('answer in your reply here, not in a separate message');
  });

  it('says a person scheduled it when no agent created it', async () => {
    mockFindById.mockResolvedValue({
      id: ID,
      name: 'Check backlog',
      agentId: 'test-agent-a',
      createdByAgentId: null,
    });
    expect(await buildAutomationWakeNote(WAKE, 'test-agent-a')).toContain(
      '(scheduled by a person)'
    );
  });

  it('is absent without a wake marker, for another agent, or when the row is gone', async () => {
    expect(await buildAutomationWakeNote(undefined, 'test-agent-a')).toBeNull();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(await buildAutomationWakeNote(WAKE, 'test-agent-b')).toBeNull();
    mockFindById.mockResolvedValue(null);
    expect(await buildAutomationWakeNote(WAKE, 'test-agent-a')).toBeNull();
  });

  it('leaves the note out when the lookup fails', async () => {
    mockFindById.mockRejectedValue(new Error('db down'));
    expect(await buildAutomationWakeNote(WAKE, 'test-agent-a')).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});
