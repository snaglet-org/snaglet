import { fetchData, getApiUrl } from './core';

/**
 * One row of a thread's execution history, as returned by `GET /api/runs`.
 *
 * `agentId`/`agentName` are nullable: the run survives its agent's deletion
 * (the FK is SET NULL), so the UI must render a fallback label rather than
 * assume a name is present.
 */
export interface RunListItem {
  id: string;
  agentId: string | null;
  agentName: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

export const runsApi = {
  /**
   * Recent runs for a thread, newest first.
   *
   * Query string is built with URLSearchParams against the relative path —
   * `new URL(getApiUrl(...))` throws on the relative dev base.
   */
  listByThread: (threadId: string, params: { limit?: number; agentId?: string } = {}) => {
    const search = new URLSearchParams({ threadId });
    if (params.limit != null) search.set('limit', String(params.limit));
    // Narrow server-side: each agent row needs its own newest-N, or a chatty
    // agent fills the limit window and hides a quieter one's runs.
    if (params.agentId) search.set('agentId', params.agentId);
    return fetchData<RunListItem[]>(`${getApiUrl('/runs')}?${search.toString()}`);
  },
};
