import { generateId, isoNow } from '@snaglet/shared/utils';
import type { ChainStamp } from './customHooks/chainStamp';

export type PendingAgentMessageReason =
  | 'mentioned'
  | 'all-mode-thread-message'
  // A teammate spoke without tagging this running agent (mentioned mode).
  // Held, not delivered, until a message that does reach the agent arrives, so
  // the agent catches up on the group's talk in order first.
  | 'thread-message'
  | 'user-mid-run'
  | 'system';

interface PendingAgentMessage {
  id: string;
  threadId: string;
  targetAgentId: string;
  senderAgentId?: string | null;
  senderUserId?: string | null;
  senderName: string;
  content: string;
  createdAt: string;
  reason: PendingAgentMessageReason;
  sourceMessageId?: string;
  /**
   * The sender's hook chain context, set only for a tool-dispatched
   * seed sent from a hook-caused context. A run that has it injected raises its
   * ambient depth to it. Absent = a person's or untraced message (depth 0).
   */
  chain?: ChainStamp | null;
  read: boolean;
}

interface EnqueuePendingAgentMessageInput {
  id?: string;
  threadId: string;
  targetAgentId: string;
  senderAgentId?: string | null;
  senderUserId?: string | null;
  senderName: string;
  content: string;
  createdAt?: string;
  reason: PendingAgentMessageReason;
  sourceMessageId?: string;
  chain?: ChainStamp | null;
}

class PendingAgentMessageService {
  private messagesByThreadAgent = new Map<string, PendingAgentMessage[]>();

  enqueue(input: EnqueuePendingAgentMessageInput): PendingAgentMessage {
    const message: PendingAgentMessage = {
      id: input.id ?? generateId('pending_agent_message'),
      threadId: input.threadId,
      targetAgentId: input.targetAgentId,
      senderAgentId: input.senderAgentId ?? null,
      senderUserId: input.senderUserId ?? null,
      senderName: input.senderName,
      content: input.content,
      createdAt: input.createdAt ?? isoNow(),
      reason: input.reason,
      sourceMessageId: input.sourceMessageId,
      ...(input.chain ? { chain: input.chain } : {}),
      read: false,
    };
    const key = this.key(input.threadId, input.targetAgentId);
    const queue = this.messagesByThreadAgent.get(key) ?? [];
    queue.push(message);
    this.messagesByThreadAgent.set(key, queue);
    return message;
  }

  listUnread(threadId: string, targetAgentId: string): PendingAgentMessage[] {
    return this.list(threadId, targetAgentId).filter((message) => !message.read);
  }

  readAndMark(threadId: string, targetAgentId: string): PendingAgentMessage[] {
    const unread = this.listUnread(threadId, targetAgentId).sort(comparePendingMessages);
    const unreadIds = new Set(unread.map((message) => message.id));
    for (const message of this.list(threadId, targetAgentId)) {
      if (unreadIds.has(message.id)) message.read = true;
    }
    return unread;
  }

  /**
   * Take the unread messages up to and including the LAST one `isTrigger` says
   * is deliverable now, oldest first, and mark just those read. Unread messages
   * after it stay queued; if nothing is deliverable, nothing is taken. This is
   * how held messages wait for the next one that reaches the agent and then go
   * out ahead of it, in order.
   */
  takeThroughLast(
    threadId: string,
    targetAgentId: string,
    isTrigger: (message: PendingAgentMessage) => boolean
  ): PendingAgentMessage[] {
    const unread = this.listUnread(threadId, targetAgentId).sort(comparePendingMessages);
    let last = -1;
    unread.forEach((message, index) => {
      if (isTrigger(message)) last = index;
    });
    if (last < 0) return [];
    const taken = unread.slice(0, last + 1);
    const takenIds = new Set(taken.map((message) => message.id));
    for (const message of this.list(threadId, targetAgentId)) {
      if (takenIds.has(message.id)) message.read = true;
    }
    return taken;
  }

  hasUnread(threadId: string, targetAgentId: string): boolean {
    return this.listUnread(threadId, targetAgentId).length > 0;
  }

  /**
   * Drop the still-unread entries queued for one persisted message. For a
   * delivery the target never reached mid-run: its next wake reads the row
   * from replay, so the queued copy would only show it twice.
   */
  discardUnreadBySource(threadId: string, targetAgentId: string, sourceMessageId: string): void {
    const key = this.key(threadId, targetAgentId);
    const queue = this.messagesByThreadAgent.get(key);
    if (!queue) return;
    const kept = queue.filter((m) => m.read || m.sourceMessageId !== sourceMessageId);
    if (kept.length === 0) this.messagesByThreadAgent.delete(key);
    else this.messagesByThreadAgent.set(key, kept);
  }

  clearAgent(threadId: string, targetAgentId: string): void {
    this.messagesByThreadAgent.delete(this.key(threadId, targetAgentId));
  }

  clearThread(threadId: string): void {
    for (const key of this.messagesByThreadAgent.keys()) {
      if (key.startsWith(`${threadId}:`)) this.messagesByThreadAgent.delete(key);
    }
  }

  resetForTests(): void {
    this.messagesByThreadAgent.clear();
  }

  private list(threadId: string, targetAgentId: string): PendingAgentMessage[] {
    return this.messagesByThreadAgent.get(this.key(threadId, targetAgentId)) ?? [];
  }

  private key(threadId: string, targetAgentId: string): string {
    return `${threadId}:${targetAgentId}`;
  }
}

function comparePendingMessages(a: PendingAgentMessage, b: PendingAgentMessage): number {
  const createdAtDelta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  if (Number.isFinite(createdAtDelta) && createdAtDelta !== 0) return createdAtDelta;
  // Same millisecond: keep the order they were queued in (the sort is stable).
  // Ids are random, so ordering by them would shuffle messages sent together.
  return 0;
}

export const pendingAgentMessages = new PendingAgentMessageService();
