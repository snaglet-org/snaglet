/**
 * Thread history trimming API client.
 *
 * Kept as its own module rather than folded into `threads.ts` so the
 * destructive two-phase contract stays visually separate from ordinary thread
 * reads: nothing here is safe to call speculatively except `getStats` and
 * `preview`.
 *
 * The client never computes counts or byte totals. Everything displayed comes
 * back from the server, and `apply` returns the server's own `token` verbatim —
 * altering any field of a reviewed plan invalidates it by design.
 */

import { fetchJson, getApiUrl } from './core';
import type { ApiResponse } from './core';
import type {
  ThreadTrimApplyResult,
  ThreadTrimPreview,
  ThreadTrimStats,
} from '@snaglet/shared/types';

export interface TrimPreviewParams {
  removeSummaries: boolean;
  firstRetainedIndex?: number;
  lastRetainedIndex?: number;
  firstRetainedMessageId?: string;
  lastRetainedMessageId?: string;
  /** Aborts an in-flight preview when the slider moves again. */
  signal?: AbortSignal;
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  const r = await fetchJson<ApiResponse<T>>(url, init);
  return r.data;
}

export const threadTrimApi = {
  /** Canonical thread totals — the same calculation the panel's figures use. */
  getStats: async (threadId: string, signal?: AbortSignal): Promise<ThreadTrimStats> => {
    const init: RequestInit = {};
    if (signal) init.signal = signal;
    const r = await fetchJson<ApiResponse<ThreadTrimStats>>(
      getApiUrl(`/threads/${threadId}/trim/stats`),
      init
    );
    return r.data;
  },

  /**
   * Resolve a proposed cut. The server may widen the retained interval to keep
   * runs whole, so `firstRetained` / `lastRetained` in the response — not the
   * requested indices — are what the UI must display and later submit.
   */
  preview: (threadId: string, params: TrimPreviewParams): Promise<ThreadTrimPreview> => {
    const { signal, ...body } = params;
    return post<ThreadTrimPreview>(getApiUrl(`/threads/${threadId}/trim/preview`), body, signal);
  },

  /** Execute a reviewed plan. Transactional server-side; all or nothing. */
  apply: (
    threadId: string,
    plan: {
      firstRetainedMessageId: string;
      lastRetainedMessageId: string;
      removeSummaries: boolean;
      token: string;
    }
  ): Promise<ThreadTrimApplyResult> =>
    post<ThreadTrimApplyResult>(getApiUrl(`/threads/${threadId}/trim/apply`), plan),
};
