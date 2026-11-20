/**
 * appendAgentToolAllowList — the "Always allow" answer on a tool prompt (and a
 * helper's grant) adds one tool to an agent's allow-list outside
 * agentService.update. It must still announce `agent.updated`, so an open
 * agent pane shows the new tool without a reload; adding a tool that is
 * already listed changes nothing and announces nothing.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindById = jest.fn<(id: string) => Promise<unknown>>();
const mockAppend = jest.fn<(id: string, toolId: string) => Promise<unknown>>();
jest.mock('@snaglet/db', () => ({
  Agents: {
    findById: (id: string) => mockFindById(id),
    appendToolAccessAllowList: (id: string, toolId: string) => mockAppend(id, toolId),
  },
}));

const mockEmit = jest.fn();
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (event: unknown) => mockEmit(event),
}));

import { appendAgentToolAllowList } from '@server/services/agentToolAllowList';

const row = (allow: string[] | null, updatedAt: string) => ({
  id: 'agent-1',
  name: 'Ada',
  toolAccessAllowList: allow,
  updatedAt,
});

beforeEach(() => {
  mockFindById.mockReset();
  mockAppend.mockReset();
  mockEmit.mockReset();
});

describe('appendAgentToolAllowList', () => {
  it('announces the allow-list with the revision the append itself set', async () => {
    // The read-back already sees a later write (r3): the event must still
    // carry the append's own revision (r2), or a pane holding r3 from its own
    // save would skip it as an echo.
    mockFindById
      .mockResolvedValueOnce(row(['search'], 'r1'))
      .mockResolvedValueOnce(row(['search', 'shell_exec'], 'r3'));
    mockAppend.mockResolvedValue({ id: 'agent-1', updatedAt: 'r2' });

    const after = await appendAgentToolAllowList('agent-1', 'shell_exec');

    expect(mockAppend).toHaveBeenCalledWith('agent-1', 'shell_exec');
    expect(after).toMatchObject({ toolAccessAllowList: ['search', 'shell_exec'] });
    expect(mockEmit.mock.calls).toEqual([
      [
        {
          type: 'agent.updated',
          agentId: 'agent-1',
          changed: ['toolAccessAllowList'],
          updatedAt: 'r2',
        },
      ],
    ]);
  });

  it('announces nothing when the tool was already allowed', async () => {
    mockFindById
      .mockResolvedValueOnce(row(['shell_exec'], 'r1'))
      .mockResolvedValueOnce(row(['shell_exec'], 'r2'));
    mockAppend.mockResolvedValue({ id: 'agent-1' });

    await appendAgentToolAllowList('agent-1', 'shell_exec');

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('returns null and announces nothing for an agent that is gone', async () => {
    mockFindById.mockResolvedValue(null);
    mockAppend.mockResolvedValue(null);

    expect(await appendAgentToolAllowList('missing', 'shell_exec')).toBeNull();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
