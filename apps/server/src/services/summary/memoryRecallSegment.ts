/**
 * memoryRecallSegment — automatic "your relevant memories" surfacing for the
 * ephemeral turn-context tail.
 *
 * Every wake, the agent's own memory store, plus the kept facts about the
 * thread's human (member-owned memories they approved), is queried with the
 * turn's inbound context (latest thread message + thread title) and the top
 * matches — capped hard at {@link MEMORY_RECALL_CAP} — are rendered as one
 * compact line each. A fact about the human reads "about <their name>".
 * The block rides the per-turn ephemeral tail (behind the durable cache
 * breakpoint), so per-turn variance costs
 * only the bounded tail, never the cached prefix. It is never persisted as a
 * message row and never replayed.
 *
 * Relevance floor — inject nothing rather than pad with weak matches. The
 * admission rule (a row must stand out from the other candidates, not clear a
 * fixed cosine) lives in ./memoryRecallFloor.ts.
 *
 * Query — what this turn is responding to: the thread title plus the latest
 * message not written by this agent (thread events skipped). The agent's own
 * last reply is generic process prose that matches every agent-written memory
 * about equally, so it is used only when nothing inbound exists.
 *
 * Best-effort throughout: any failure (embedding provider down, DB error)
 * logs a warning and injects nothing — never into the turn.
 */

import { Messages } from '@snaglet/db/tables/messages';
import type { MemorySearchResult } from '@snaglet/db/tables/memories';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { memoryService } from '@server/services/MemoryService';
import { selectRecalledMemories } from './memoryRecallFloor';
import { resolveMemoryRecallProjectScope } from './memoryRecallScope';
import { resolveMemberName, resolveProposalMemberId } from './threadHuman';

/** Hard cap on injected memories per turn. */
export const MEMORY_RECALL_CAP = 5;

/**
 * How many candidates to pull from recall before the floor is applied. The
 * floor compares each row with the mean of this candidate set, and was
 * calibrated at 10 — change both together (see memoryRecallFloor.ts).
 */
const MEMORY_RECALL_FETCH_LIMIT = 10;

/** How far back to look for the latest inbound (non-self) message. */
const MEMORY_RECALL_INBOUND_LOOKBACK = 20;

/** Per-entry render budget; memories can be multi-KB, the tail must stay small. */
export const MEMORY_RECALL_ENTRY_MAX_CHARS = 300;

/** Recall queries are embedded + FTS-parsed; beyond this length adds nothing. */
const MEMORY_RECALL_QUERY_MAX_CHARS = 2000;

export interface MemoryRecallSegmentInput {
  agentId: string;
  /** Owner display name for the per-line attribution; falls back to agentId. */
  agentName?: string | null;
  threadId: string;
  /** Folded into the recall query when present (cheap extra signal). */
  threadTitle?: string | null;
  /**
   * Whether the agent has any `memory_`-prefixed tool assigned — the same
   * prefix gate perceptionBlock uses for its memory guidance. An agent
   * without memory tools gets no injection (it could not act on the advice to
   * edit/forget, and the block would advertise tools it cannot call).
   */
  hasMemoryTools: boolean;
}

/**
 * The message this wake is responding to: the newest non-event message not
 * written by `agentId`, else the newest message of any author. Exported for
 * tests.
 */
export async function findInboundMessage(
  threadId: string,
  agentId: string
): Promise<{ content: string } | null> {
  const recent = await Messages.getRecentDescending(threadId, MEMORY_RECALL_INBOUND_LOOKBACK);
  const inbound = recent.find(
    (m) => m.messageType !== 'thread_event' && m.agentId !== agentId && m.content?.trim()
  );
  if (inbound) return inbound;
  return recent.find((m) => m.messageType !== 'thread_event' && m.content?.trim()) ?? null;
}

/**
 * Compact age label for one memory line: "today", "34d ago", "3mo ago",
 * "2y ago". Returns null when createdAt is unparseable (age is then omitted
 * rather than rendered as NaN).
 */
export function formatMemoryAge(createdAt: string, nowMs: number = Date.now()): string | null {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;
  const days = Math.floor((nowMs - created) / 86_400_000);
  if (days <= 0) return 'today';
  if (days < 60) return `${days}d ago`;
  if (days < 700) return `${Math.round(days / 30.44)}mo ago`;
  return `${Math.round(days / 365.25)}y ago`;
}

/** One line per memory: `· <content> (<owner>, <age>)`. Exported for tests. */
export function renderMemoryLine(
  row: MemorySearchResult,
  ownerName: string,
  nowMs: number = Date.now()
): string {
  // One line per memory: collapse all whitespace runs (memories are often
  // multi-line) before truncating.
  let content = row.content.replace(/\s+/g, ' ').trim();
  if (content.length > MEMORY_RECALL_ENTRY_MAX_CHARS) {
    content = `${content.slice(0, MEMORY_RECALL_ENTRY_MAX_CHARS - 1).trimEnd()}…`;
  }
  const age = formatMemoryAge(row.createdAt, nowMs);
  const meta = age ? `${ownerName}, ${age}` : ownerName;
  return `· ${content} (${meta})`;
}

/**
 * Framing header, one line in the voice of the surrounding turn-context tail:
 * whose memories these are (the agent's own, and facts the human kept about
 * themselves). How to read one (a lead, not a premise; fix or delete your own
 * when wrong) is said once in the cached system prompt's Memory section
 * (perceptionBlock, shown to agents that hold the `memory` tool, the same
 * agents recall runs for), so the per-turn tail does not pay for it again.
 */
export const MEMORY_RECALL_HEADER =
  '**Recalled memories** for this turn: your own, and facts the person you work with ' +
  'kept about themselves ("about <name>").';

/** Attribution for a kept fact about the thread's human when their name is unknown. */
const MEMBER_FALLBACK_NAME = 'the user';

/**
 * Build the recalled-memories segment for this wake, or null when there is
 * nothing worth injecting (no memory tools, no inbound context to query with,
 * nothing above the relevance floor, or recall failed). Best-effort: never
 * throws into the turn.
 */
export async function buildMemoryRecallSegment(
  input: MemoryRecallSegmentInput
): Promise<string | null> {
  if (!input.hasMemoryTools || !input.threadId) return null;
  try {
    // Query = the thread title plus what this wake is responding to (the
    // latest message not written by this agent).
    const inbound = await findInboundMessage(input.threadId, input.agentId);
    const query = [input.threadTitle, inbound?.content]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
      .slice(0, MEMORY_RECALL_QUERY_MAX_CHARS)
      .trim();
    if (!query) return null;

    // Project-family scope: in a project thread, only this project
    // family's memories (+ agent-global ones, + projects the query names) are
    // candidates. Flat thread → null → unscoped.
    const projectScope = await resolveMemoryRecallProjectScope(input.threadId, query);

    // The thread's single human (none, or several: nobody's facts are added).
    // Best-effort: failing to resolve them must not cost the agent its own recall.
    const memberId = await resolveProposalMemberId(input.threadId).catch(() => null);

    const results = await memoryService.recall({
      agentId: input.agentId,
      threadId: input.threadId,
      query,
      limit: MEMORY_RECALL_FETCH_LIMIT,
      ...(projectScope ? { projectScope } : {}),
      ...(memberId ? { alsoMemberId: memberId } : {}),
    });
    const admitted = selectRecalledMemories(results).slice(0, MEMORY_RECALL_CAP);
    if (admitted.length === 0) return null;

    const ownerName = input.agentName?.trim() || input.agentId;
    const aboutMember =
      memberId && admitted.some((row) => row.memberId)
        ? `about ${(await resolveMemberName(memberId)) ?? MEMBER_FALLBACK_NAME}`
        : null;
    const now = Date.now();
    const lines = admitted.map((row) =>
      renderMemoryLine(row, row.memberId && aboutMember ? aboutMember : ownerName, now)
    );
    return [MEMORY_RECALL_HEADER, ...lines].join('\n');
  } catch (err) {
    logger.warn('[memoryRecall] buildMemoryRecallSegment failed — injecting nothing', {
      agentId: input.agentId,
      threadId: input.threadId,
      err: getErrorMessage(err),
    });
    return null;
  }
}
