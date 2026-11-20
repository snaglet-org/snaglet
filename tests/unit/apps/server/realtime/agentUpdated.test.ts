/**
 * `agent.updated` carries the row's revision: the agent's `updated_at` after
 * the write. An open agent pane compares it with the revision it already
 * holds, so its own save's echo needs no refetch, and any other write does.
 * Writes that do not touch the agent row (skills) carry no revision.
 */
const mockEmit = jest.fn();
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (event: unknown) => mockEmit(event),
}));

import { emitAgentRowChanges, emitAgentUpdated } from '@server/realtime/surfaces/agents';

beforeEach(() => {
  mockEmit.mockReset();
});

describe('emitAgentUpdated', () => {
  it('adds the revision when the caller has one', () => {
    emitAgentUpdated('a1', ['role'], '2026-11-16T10:00:00.123456+00:00');
    expect(mockEmit.mock.calls).toEqual([
      [
        {
          type: 'agent.updated',
          agentId: 'a1',
          changed: ['role'],
          updatedAt: '2026-11-16T10:00:00.123456+00:00',
        },
      ],
    ]);
  });

  it('leaves the revision out when there is none', () => {
    emitAgentUpdated('a1', ['skills']);
    expect(mockEmit.mock.calls).toEqual([
      [{ type: 'agent.updated', agentId: 'a1', changed: ['skills'] }],
    ]);
  });
});

describe('emitAgentRowChanges', () => {
  const before = { id: 'a1', role: 'CTO', identity: 'old', updatedAt: '2026-11-16T09:00:00+00:00' };

  it('announces the changed fields with the written row’s revision', () => {
    const after = { ...before, identity: 'new', updatedAt: '2026-11-16T10:00:00+00:00' };
    emitAgentRowChanges('a1', before, after, ['role', 'identity']);
    expect(mockEmit.mock.calls).toEqual([
      [
        {
          type: 'agent.updated',
          agentId: 'a1',
          changed: ['identity'],
          updatedAt: '2026-11-16T10:00:00+00:00',
        },
      ],
    ]);
  });

  it('stays quiet when nothing named changed', () => {
    emitAgentRowChanges('a1', before, { ...before, updatedAt: 'later' }, ['role']);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
