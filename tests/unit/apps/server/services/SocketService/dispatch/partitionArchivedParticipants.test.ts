/**
 * partitionArchivedParticipants — the single archived-exclusion rule shared by
 * both dispatch roster builders (socket chatHandlers + tool buildDispatchDeps).
 *
 * Proves the dispatch-exclusion invariant in isolation: an archived agent that
 * is still a thread participant is dropped from the live (dispatch/wake/mention)
 * set while its id stays visible as archived. `Agents.findByIds` is mocked to
 * assert we rely only on the per-id `archived` flag it surfaces.
 */

const mockFindByIds = jest.fn();

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findByIds: (...args: unknown[]) => mockFindByIds(...args) },
}));

import { partitionArchivedParticipants } from '@server/services/SocketService/dispatch/partitionArchivedParticipants';

function row(id: string, archived: boolean) {
  return { id, archived, archivedAt: archived ? '2026-07-06T00:00:00Z' : null };
}

describe('partitionArchivedParticipants', () => {
  beforeEach(() => jest.clearAllMocks());

  it('drops archived participants from liveIds, keeps them in archivedIds', async () => {
    mockFindByIds.mockResolvedValue([row('agent-live', false), row('agent-archived', true)]);

    const { liveIds, archivedIds } = await partitionArchivedParticipants([
      'agent-live',
      'agent-archived',
    ]);

    expect(liveIds).toEqual(['agent-live']);
    expect(archivedIds).toEqual(['agent-archived']);
  });

  it('preserves input order for the live set', async () => {
    mockFindByIds.mockResolvedValue([row('a', false), row('b', true), row('c', false)]);

    const { liveIds } = await partitionArchivedParticipants(['a', 'b', 'c']);
    expect(liveIds).toEqual(['a', 'c']);
  });

  it('returns every id as live when none are archived (no wasted filtering)', async () => {
    mockFindByIds.mockResolvedValue([row('a', false), row('b', false)]);
    const { liveIds, archivedIds } = await partitionArchivedParticipants(['a', 'b']);
    expect(liveIds).toEqual(['a', 'b']);
    expect(archivedIds).toEqual([]);
  });

  it('short-circuits on empty input without hitting the DB', async () => {
    const result = await partitionArchivedParticipants([]);
    expect(result).toEqual({ liveIds: [], archivedIds: [] });
    expect(mockFindByIds).not.toHaveBeenCalled();
  });

  it('collapses to no live participants when every participant is archived', async () => {
    mockFindByIds.mockResolvedValue([row('a', true), row('b', true)]);
    const { liveIds, archivedIds } = await partitionArchivedParticipants(['a', 'b']);
    expect(liveIds).toEqual([]);
    expect(archivedIds).toEqual(['a', 'b']);
  });
});
