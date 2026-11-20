// In-run delivery for tool-dispatch seeds (thread_send from an agent or an
// external MCP member) that land on a thread whose run lock is already held.
// Split out of dispatchToThread.ts so it can be tested without the dispatch
// core, and so the rule lives in one place:
//
//   per-wake facts         -> composeTurnContextTail (the turn-context block)
//   anything mid-run       -> pendingAgentMessages -> tool-result append
//
// This module is the "anything mid-run" half for tool-dispatched messages.

import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import type { ChainStamp } from '@server/services/customHooks/chainStamp';

/** Who authored a tool-dispatch seed. `user` is always injected; `agent` is mode-gated. */
export type SeedSender =
  | { kind: 'user'; name: string; userId: string }
  | { kind: 'agent'; name?: string };

/**
 * In-run delivery for a tool-dispatch seed that hit a busy thread.
 *
 * Targets = the agents this message would have woken (the dispatch set: the
 * @-mentioned agents in mentioned mode, every participant in all mode, never
 * the sender) ∩ the agents with a live thread-run on this thread. Each gets the
 * message through pendingAgentMessages, i.e. the same seam socket sends and
 * agent @-mentions use: drained at the next client-tool boundary, gated by
 * decideMidRunInjection, formatted by formatPeerMessage (named sender,
 * neutralized body), appended after the tool results so the cached prefix is
 * untouched.
 *
 * When every target is running, the seed is marked as expecting injection so
 * the post-run re-dispatch skips it once all of them have actually seen it. If
 * some target is idle, the backstop stays armed (a late double answer beats a
 * lost wake). Returns the agent ids it was queued for.
 */
export function enqueueSeedForRunningTargets(args: {
  threadId: string;
  messageId: string;
  message: string;
  senderId: string;
  sender: SeedSender;
  /** Participant id → display name (dispatch deps), for a peer sender's label. */
  agentNameMap?: ReadonlyMap<string, string>;
  dispatchSet: Set<string>;
  mentionedAgentIds: string[];
  resolveParticipantId: (mentionedId: string) => string | undefined;
  /**
   * The sender's hook chain context (the same stamp as the row's
   * `metadata.chain`). A run that has the message injected acts on it at this
   * depth. Null/absent = a person's message, depth 0.
   */
  chain?: ChainStamp | null;
}): string[] {
  const running = new Set<string>();
  for (const item of activeWorkRegistry.snapshot()) {
    if (item.kind === 'thread-run' && item.threadId === args.threadId && item.agentId) {
      running.add(item.agentId);
    }
  }
  const mentioned = new Set(
    args.mentionedAgentIds
      .map((id) => args.resolveParticipantId(id))
      .filter((id): id is string => Boolean(id))
  );
  const targets = Array.from(args.dispatchSet).filter(
    // Never into the sender's own run — an agent's own post is not news to it.
    (agentId) => agentId !== args.senderId && running.has(agentId)
  );
  if (targets.length === 0) return [];
  // Synchronous on purpose: no await between the caller's recordSkippedSeed
  // and these enqueues, so the run cannot end in between and leave a stale
  // queued copy for the agent's next run (which already replays it).
  const senderName = args.sender.name ?? args.agentNameMap?.get(args.senderId) ?? args.senderId;
  for (const agentId of targets) {
    pendingAgentMessages.enqueue({
      threadId: args.threadId,
      targetAgentId: agentId,
      ...(args.sender.kind === 'user'
        ? { senderUserId: args.sender.userId }
        : { senderAgentId: args.senderId }),
      senderName,
      content: args.message,
      reason: mentioned.has(agentId) ? 'mentioned' : 'all-mode-thread-message',
      sourceMessageId: args.messageId,
      ...(args.chain ? { chain: args.chain } : {}),
    });
  }
  const allTargetsRunning = Array.from(args.dispatchSet).every(
    (id) => id === args.senderId || running.has(id)
  );
  if (allTargetsRunning) {
    activeRunTracker.expectSeedInjection(args.threadId, args.messageId, targets);
  }
  return targets;
}
