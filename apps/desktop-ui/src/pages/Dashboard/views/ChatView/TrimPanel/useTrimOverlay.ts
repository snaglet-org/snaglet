import { useMemo } from 'react';
import type { TrimOverlay } from '../MessageList/MessageList';
import type { UseThreadTrimResult } from './useThreadTrim';

/**
 * The cut the open trim panel proposes, as the message list dims it: the
 * server-resolved plan (never the raw handle request), plus the boundary to
 * bring into view. Null while the panel is closed or before a preview lands.
 * Shared by every pane that hosts the trim panel next to its message list.
 */
export function useTrimOverlay(trim: UseThreadTrimResult, open: boolean): TrimOverlay | null {
  const { preview, seekRequest } = trim;
  return useMemo<TrimOverlay | null>(() => {
    if (!open || !preview) return null;
    return {
      firstRetainedId: preview.firstRetained.messageId,
      lastRetainedId: preview.lastRetained.messageId,
      sides: preview.sides,
      // A seek request names an edge; the message it lands on is whichever one
      // the resolved plan put that boundary at, so scrubbing and jumping both
      // target the cut that will really happen.
      seek: seekRequest
        ? {
            messageId:
              seekRequest.edge === 'first'
                ? preview.firstRetained.messageId
                : preview.lastRetained.messageId,
            nonce: seekRequest.nonce,
          }
        : null,
    };
  }, [open, preview, seekRequest]);
}
