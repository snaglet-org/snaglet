/**
 * voiceCatchUp — FLOOR-GATED GENERATION catch-up.
 *
 * When a run parks on the speaking floor and is later granted, it must generate
 * against a CURRENT world — not the one its context was assembled in. On acquire
 * the turn loop reads every thread row that landed after a watermark cursor and
 * folds them here into append-only injection blocks.
 *
 * Kept as a tiny, dependency-light module (only a MessageRow type) so both the
 * turn loop and its tests can use it without dragging the whole turn graph in.
 */

import type { MessageRow } from '@snaglet/db/tables/messages';

/** Cursor into the thread's message stream: the newest row already in context. */
export interface VoiceCatchUpCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * Fold every thread message newer than the cursor into append-only injection
 * blocks. Pure.
 *
 * Included: peer utterances and genuine user sends. These append at the tail
 * (behind the message-tail cache breakpoint), so they never disturb the
 * byte-stable replay prefix — cache-safe, exactly like the mid-run peer-injection
 * path they mirror.
 *
 * Excluded: the agent's own rows (already in its context as assistant turns);
 * mid-run user injections (`injectedDuringRun` — owned by the tool-seam peer
 * injection path, so folding them here too would double them); non-conversational
 * rows (thread_event / machine narration). The returned cursor always advances to
 * the last row SEEN (folded or not), so no row is ever folded twice across
 * successive acquires.
 */
export function buildVoiceCatchUpBlocks(
  rows: readonly MessageRow[],
  opts: { selfAgentId: string; agentNameMap: Map<string, string> }
): { blocks: string[]; cursor: VoiceCatchUpCursor | null } {
  let cursor: VoiceCatchUpCursor | null = null;
  const blocks: string[] = [];
  for (const row of rows) {
    cursor = { createdAt: row.createdAt, id: row.id };
    if (row.agentId === opts.selfAgentId) continue;
    if (row.injectedDuringRun) continue;
    if (row.messageType !== 'message' && row.messageType !== 'question') continue;
    const content = (row.content ?? '').trim();
    if (!content) continue;
    const who = row.agentId ? (opts.agentNameMap.get(row.agentId) ?? 'A teammate') : 'The user';
    blocks.push(`[While you were listening — ${who} said]\n${content}`);
  }
  return { blocks, cursor };
}
