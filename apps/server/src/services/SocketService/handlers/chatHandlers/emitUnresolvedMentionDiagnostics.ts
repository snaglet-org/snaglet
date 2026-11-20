import { wsService } from '@server/services/WebSocketService';
import { LogsService } from '@server/services/LogsService';
import type { MentionResult } from '@server/services/MentionParser';

export interface EmitUnresolvedMentionDiagnosticsInput {
  /** Mention resolution result for the incoming user message. */
  readonly mentions: MentionResult;
  /** Whether the current thread is a group chat (no-op for solo threads). */
  readonly isGroup: boolean;
  /** Map of agent ID → display name for participants in this thread. */
  readonly agentNameMap: ReadonlyMap<string, string>;
  /** Thread ID, used for broadcast and log context. */
  readonly threadId: string;
  /** Thread display name, used for log context. */
  readonly threadName: string;
}

/**
 * Surface raw `@tokens` from the user message that didn't resolve to a participant.
 *
 * Without this, typos like `@paty` (instead of `@patty`) get silently dropped — the
 * mention parser sees the token but the resolver doesn't find a match, so nothing
 * happens. This emits both a UI broadcast (so the client can show a warning bubble)
 * and a server log entry (for debugging).
 *
 * No-op when:
 *   - the thread is solo (no participants to mismatch against), OR
 *   - the user message contained zero raw `@tokens`.
 *
 * Side effects only: broadcasts via `wsService` and logs via `LogsService`.
 * No return value.
 */
export function emitUnresolvedMentionDiagnostics(
  input: EmitUnresolvedMentionDiagnosticsInput
): void {
  const { mentions, isGroup, agentNameMap, threadId, threadName } = input;

  if (!isGroup || mentions.rawMentions.length === 0) {
    return;
  }

  const resolvedCountLC = new Set(mentions.mentionedAgentIds.map((id) => id.toLowerCase()));
  const nameToIdLC = new Map<string, string>();
  for (const [id, name] of agentNameMap.entries()) {
    nameToIdLC.set(name.trim().toLowerCase(), id.toLowerCase());
  }

  for (const rawToken of mentions.rawMentions) {
    const normalized = rawToken.trim().toLowerCase();
    const mappedId = nameToIdLC.get(normalized);
    if (!mappedId || !resolvedCountLC.has(mappedId)) {
      wsService.broadcastToChannel(threadId, {
        type: 'chat:mention-skipped',
        payload: {
          threadId,
          mentionerAgentId: null,
          mentionerName: null,
          mentionedAgentId: null,
          mentionedName: rawToken,
          reason: 'unresolved-name',
        },
      });
      LogsService.socket.event('mention skipped (unresolved name)', {
        threadName,
        threadId,
        mentionedName: rawToken,
      });
    }
  }
}
