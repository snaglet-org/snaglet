/**
 * bargeIn — the barge-in routing decision + heard-up-to marker.
 *
 * When the user speaks over an agent, the next finalized utterance routes only
 * to the interrupted agent (no pill mentions). How it reaches that agent depends
 * on the run's phase:
 *   - mid-tool-run  → inject (user messages always inject via the normal mid-run
 *                     enqueue path — nothing special to do here; the chat-send
 *                     path enqueues because a run is active),
 *   - mid-speech    → abort the run first, then send so it redispatches on the
 *                     new utterance (a fresh run, because the abort released the
 *                     session lock by the time the user finishes speaking).
 *
 * The decision is a pure function of one boolean so it is trivially testable; the
 * runtime callers read that boolean from runPhaseTracker.
 */

import { Messages } from '@snaglet/db/tables/messages';
import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { getSynthesizedMs, getSpokenText, getReconciledMessageId } from './ttsDurationTracker';
import type { VoiceHeardUpTo } from './types';

export type BargeInAction = 'inject' | 'abort-redispatch';

/** Pure decision: mid-tool → inject; mid-speech (no tools) → abort+redispatch. */
export function decideBargeInAction(opts: { toolInFlight: boolean }): BargeInAction {
  return opts.toolInFlight ? 'inject' : 'abort-redispatch';
}

/** Snap an offset back to the end of the last complete word (no mid-word cut). */
function snapToWordBoundary(content: string, rawOffset: number): number {
  const off = Math.max(0, Math.min(Math.round(rawOffset), content.length));
  if (off >= content.length) return content.length;
  if (/\s/.test(content[off]!)) return off; // already at a boundary
  const lastSpace = content.lastIndexOf(' ', off);
  return lastSpace > 0 ? lastSpace : off;
}

/**
 * Compute the char offset the user's ears reached. Prefers `playedMs`: with the
 * utterance's total synthesized duration (ttsDurationTracker) the server maps
 * ms → chars precisely and snaps to a word boundary. Falls back to the client
 * `charOffset`, then to the whole utterance.
 */
function resolveOffset(content: string, heardUpTo: VoiceHeardUpTo): number {
  const totalMs = getSynthesizedMs(heardUpTo.utteranceId);
  if (
    typeof heardUpTo.playedMs === 'number' &&
    Number.isFinite(heardUpTo.playedMs) &&
    totalMs &&
    totalMs > 0
  ) {
    const ratio = Math.max(0, Math.min(heardUpTo.playedMs / totalMs, 1));
    return snapToWordBoundary(content, ratio * content.length);
  }
  if (typeof heardUpTo.charOffset === 'number' && Number.isFinite(heardUpTo.charOffset)) {
    return Math.max(0, Math.min(heardUpTo.charOffset, content.length));
  }
  return content.length;
}

/**
 * Resolve the "user heard up to" marker line from an utterance id + (playedMs or
 * charOffset). The id may be the streaming synthetic id (`${runId}:${iteration}`)
 * when the user barged in before the row persisted, so content resolution prefers
 * the tracker's stored spoken text (exactly what was synthesized/heard) and falls
 * back to the persisted message row — looked up by the reconciled real messageId
 * when the tracker aliased one. Returns null when there is nothing useful to say
 * (no text / empty slice). Appended to the barge-in message so the agent knows
 * where its speech was actually cut off.
 */
export async function resolveHeardUpToLine(
  heardUpTo: VoiceHeardUpTo | undefined
): Promise<string | null> {
  if (!heardUpTo?.utteranceId) return null;
  try {
    // Prefer tracker-stored spoken text (works mid-stream, before any row).
    let content = getSpokenText(heardUpTo.utteranceId) ?? '';
    if (content.length === 0) {
      // Fall back to the persisted row — by the reconciled messageId if we have
      // one (the id we were handed was the synthetic streaming id), else as-is.
      const rowId = getReconciledMessageId(heardUpTo.utteranceId) ?? heardUpTo.utteranceId;
      const row = await Messages.findById(rowId);
      content = typeof row?.content === 'string' ? row.content : '';
    }
    if (content.length === 0) return null;
    const offset = resolveOffset(content, heardUpTo);
    const heard = content.slice(0, offset).replace(/\s+/g, ' ').trim();
    if (heard.length === 0) return null;
    return `[voice] user heard up to: "${heard}"`;
  } catch (err) {
    LogsService.warn('heard-up-to resolution failed', {
      utteranceId: heardUpTo.utteranceId,
      error: getErrorMessage(err),
    });
    return null;
  }
}
