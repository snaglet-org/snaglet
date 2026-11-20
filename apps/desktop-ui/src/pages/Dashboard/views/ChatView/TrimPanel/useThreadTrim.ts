/**
 * Trim panel state: the proposed kept range, its debounced preview, and the
 * apply flow.
 *
 * Previews can finish out of order, and a late reply would show a cut other
 * than the one selected, so each request carries a sequence number and an
 * AbortController and only the newest reply is applied.
 *
 * `firstIndex`/`lastIndex` keep what the user asked for, never the range the
 * server resolved, so a handle only moves under the pointer and
 * `expandedForRunAtomicity` doesn't erase itself on the next round trip.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import type {
  ThreadTrimApplyResult,
  ThreadTrimPreview,
  ThreadTrimStats,
} from '@snaglet/shared/types';
import { threadTrimApi } from '@desktop/utils/api/threadTrim';

/** Settle time before a moved boundary is priced. */
const PREVIEW_DEBOUNCE_MS = 220;

export interface UseThreadTrimResult {
  stats: ThreadTrimStats | null;
  statsError: string | null;
  messageCount: number;

  removeSummaries: boolean;
  setRemoveSummaries: (value: boolean) => void;

  /** The proposed retained interval (0-based ordinals) — live handle positions. */
  firstIndex: number;
  lastIndex: number;
  setFirstIndex: (index: number) => void;
  setLastIndex: (index: number) => void;
  /**
   * Where the thread pane should seek, or null until the user asks, so opening
   * the panel doesn't scroll the thread. `nonce` changes on every request, so
   * asking for the same boundary twice seeks twice.
   */
  seekRequest: { edge: 'first' | 'last'; nonce: number } | null;
  /** Ask the pane to show a boundary — the "Jump to prefix/tail" buttons. */
  requestSeek: (edge: 'first' | 'last') => void;

  preview: ThreadTrimPreview | null;
  previewLoading: boolean;
  previewError: string | null;

  applying: boolean;
  applyError: string | null;
  apply: () => Promise<ThreadTrimApplyResult | null>;
  clearApplyError: () => void;

  /** Re-read stats and re-preview (after an external change or a trim). */
  refresh: () => void;
}

export function useThreadTrim(threadId: string): UseThreadTrimResult {
  const [stats, setStats] = useState<ThreadTrimStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [removeSummaries, setRemoveSummaries] = useState(false);
  const [firstIndex, setFirstIndexState] = useState(0);
  const [lastIndex, setLastIndexState] = useState(0);
  const [seekRequest, setSeekRequest] = useState<UseThreadTrimResult['seekRequest']>(null);
  const [preview, setPreview] = useState<ThreadTrimPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  /** False until the boundaries have been seeded from a stats response. */
  const initializedRef = useRef(false);

  const messageCount = stats?.messageCount ?? 0;
  const maxIndex = Math.max(0, messageCount - 1);

  /* stats */

  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    let canceled = false;
    setStatsError(null);
    threadTrimApi
      .getStats(threadId, controller.signal)
      .then((next) => {
        if (canceled) return;
        setStats(next);
        // Seed the boundaries to "retain everything" the first time only, so a
        // refresh after a trim does not yank the user's selection around.
        if (!initializedRef.current) {
          initializedRef.current = true;
          setFirstIndexState(0);
          setLastIndexState(Math.max(0, next.messageCount - 1));
        }
      })
      .catch((err: unknown) => {
        if (canceled || controller.signal.aborted) return;
        setStatsError(getErrorMessage(err, 'Could not read thread totals'));
      });
    return () => {
      canceled = true;
      controller.abort();
    };
  }, [threadId, refreshKey]);

  // A thread swap must not carry the previous thread's ordinals over.
  useEffect(() => {
    initializedRef.current = false;
    setStats(null);
    setPreview(null);
    setPreviewError(null);
    setApplyError(null);
    setFirstIndexState(0);
    setLastIndexState(0);
    setSeekRequest(null);
  }, [threadId]);

  /* handles */

  const clampIndex = useCallback(
    (index: number): number => Math.min(maxIndex, Math.max(0, Math.trunc(index))),
    [maxIndex]
  );

  /**
   * One seek mechanism, two entry points. Scrubbing a handle and pressing
   * "Jump to prefix/tail" both land here, so the pane cannot behave one way for
   * a drag and another way for a click.
   */
  const requestSeek = useCallback((edge: 'first' | 'last') => {
    setSeekRequest((prev) => ({ edge, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const setFirstIndex = useCallback(
    (index: number) => {
      const next = clampIndex(index);
      requestSeek('first');
      setFirstIndexState(next);
      // Handles may not cross; push the other one instead of swapping, which
      // would make a drag feel like it teleported.
      setLastIndexState((last) => (next > last ? next : last));
    },
    [clampIndex, requestSeek]
  );

  const setLastIndex = useCallback(
    (index: number) => {
      const next = clampIndex(index);
      requestSeek('last');
      setLastIndexState(next);
      setFirstIndexState((first) => (next < first ? next : first));
    },
    [clampIndex, requestSeek]
  );

  /* debounced preview */

  const seqRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!threadId || messageCount === 0) return;
    const seq = seqRef.current + 1;
    seqRef.current = seq;

    const timer = setTimeout(() => {
      inFlightRef.current?.abort();
      const controller = new AbortController();
      inFlightRef.current = controller;
      setPreviewLoading(true);
      setPreviewError(null);

      threadTrimApi
        .preview(threadId, {
          removeSummaries,
          firstRetainedIndex: firstIndex,
          lastRetainedIndex: lastIndex,
          signal: controller.signal,
        })
        .then((next) => {
          // Discard any reply that isn't for the newest request.
          if (seqRef.current !== seq) return;
          setPreview(next);
          setPreviewLoading(false);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq || controller.signal.aborted) return;
          setPreviewLoading(false);
          setPreviewError(getErrorMessage(err, 'Could not calculate the trim impact'));
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [threadId, removeSummaries, firstIndex, lastIndex, messageCount, refreshKey]);

  useEffect(() => () => inFlightRef.current?.abort(), []);

  /* apply */

  const apply = useCallback(async (): Promise<ThreadTrimApplyResult | null> => {
    if (!preview || applying) return null;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await threadTrimApi.apply(threadId, {
        firstRetainedMessageId: preview.firstRetained.messageId,
        lastRetainedMessageId: preview.lastRetained.messageId,
        removeSummaries: preview.removeSummaries,
        token: preview.token,
      });
      // The plan that just ran is spent; force a fresh stats + preview cycle so
      // nothing stale can be confirmed twice.
      setPreview(null);
      initializedRef.current = false;
      setRefreshKey((k) => k + 1);
      return result;
    } catch (err) {
      setApplyError(getErrorMessage(err, 'Could not trim this thread'));
      return null;
    } finally {
      setApplying(false);
    }
  }, [preview, applying, threadId]);

  const clearApplyError = useCallback(() => setApplyError(null), []);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return useMemo(
    () => ({
      stats,
      statsError,
      messageCount,
      removeSummaries,
      setRemoveSummaries,
      firstIndex,
      lastIndex,
      setFirstIndex,
      setLastIndex,
      seekRequest,
      requestSeek,
      preview,
      previewLoading,
      previewError,
      applying,
      applyError,
      apply,
      clearApplyError,
      refresh,
    }),
    [
      stats,
      statsError,
      messageCount,
      removeSummaries,
      firstIndex,
      lastIndex,
      setFirstIndex,
      setLastIndex,
      seekRequest,
      requestSeek,
      preview,
      previewLoading,
      previewError,
      applying,
      applyError,
      apply,
      clearApplyError,
      refresh,
    ]
  );
}
