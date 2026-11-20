/**
 * The compact thread-size totals shown in Settings → Maintenance. Reads the
 * same `/trim/stats` endpoint as the trim panel, so the two never disagree.
 * Separate from `useThreadTrim` so the summary doesn't pay for the panel's
 * preview machinery before the panel opens.
 */

import { useCallback, useEffect, useState } from 'react';
import { formatBytes, getErrorMessage } from '@snaglet/shared/utils';
import type { ThreadTrimStats } from '@snaglet/shared/types';
import { threadTrimApi } from '@desktop/utils/api/threadTrim';

export interface TrimTotalsLabel {
  /** e.g. "1,820 messages · 12.6 MB", or null before stats arrive. */
  summary: string | null;
  /** Per-table byte breakdown for the help tooltip, or null before stats arrive. */
  detail: string | null;
  /** Why the totals could not be read, when they could not. */
  error: string | null;
  stats: ThreadTrimStats | null;
  refresh: () => void;
}

export function useTrimTotalsLabel(threadId: string): TrimTotalsLabel {
  const [stats, setStats] = useState<ThreadTrimStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    let canceled = false;
    threadTrimApi
      .getStats(threadId, controller.signal)
      .then((next) => {
        if (!canceled) {
          setStats(next);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (canceled || controller.signal.aborted) return;
        setError(getErrorMessage(err, 'totals unavailable'));
      });
    return () => {
      canceled = true;
      controller.abort();
    };
  }, [threadId, nonce]);

  // A thread swap must not show the previous thread's totals.
  useEffect(() => {
    setStats(null);
    setError(null);
  }, [threadId]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  if (!stats) {
    return { summary: null, detail: null, error, stats: null, refresh };
  }

  const b = stats.totals.bytes;
  const count = stats.messageCount;
  return {
    summary: `${count.toLocaleString()} ${count === 1 ? 'message' : 'messages'} · ${formatBytes(b.total)}`,
    detail:
      `Stored: messages ${formatBytes(b.messages)} · embeddings ${formatBytes(b.messageEmbeddings)} · ` +
      `runs ${formatBytes(b.runs)} · activity ${formatBytes(b.activity)} · ` +
      `summaries ${formatBytes(b.summaries + b.summaryEmbeddings)}.`,
    error: null,
    stats,
    refresh,
  };
}
