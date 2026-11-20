import { fetchData, getApiUrl } from './core';
import type { MemoryDetailRecord, MemoryRecord, MemoryStats } from './types';

export const memoriesApi = {
  list: (agentId: string, params: { limit?: number; offset?: number; threadId?: string } = {}) => {
    const search = new URLSearchParams({ agentId });
    if (params.limit != null) search.set('limit', String(params.limit));
    if (params.offset != null) search.set('offset', String(params.offset));
    if (params.threadId) search.set('threadId', params.threadId);
    return fetchData<MemoryRecord[]>(getApiUrl(`/memories?${search.toString()}`));
  },
  /** Proposals recorded in a thread that are still waiting on a human's approval. */
  listProposed: (threadId: string) =>
    fetchData<MemoryRecord[]>(
      getApiUrl(`/memories/proposed?threadId=${encodeURIComponent(threadId)}`)
    ),
  /** Approve a proposal: it becomes an active memory. */
  approve: (id: string) =>
    fetchData<MemoryRecord>(getApiUrl(`/memories/${encodeURIComponent(id)}/approve`), {
      method: 'POST',
    }),
  /** One memory, with its agent's name and source thread's title. */
  getById: (id: string) =>
    fetchData<MemoryDetailRecord>(getApiUrl(`/memories/${encodeURIComponent(id)}`)),
  getStats: (agentId: string) =>
    fetchData<MemoryStats>(getApiUrl(`/memories/stats?agentId=${encodeURIComponent(agentId)}`)),
  /** Permanently delete one memory (a hard delete: there is no undo). */
  delete: (id: string) =>
    fetchData<{ id: string }>(getApiUrl(`/memories/${encodeURIComponent(id)}`), {
      method: 'DELETE',
    }),
};
