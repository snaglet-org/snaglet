/**
 * askNotifications — one notification for every agent ask, cleared the
 * moment the ask settles.
 *
 * An agent parks its run on the user in two ways: a tool-permission prompt
 * (SocketService/confirmation.ts, both `approval` and `allow_list` modes) and
 * a Triage question (`get_clarification`, SocketService/clarification.ts).
 * The prompt renders in the thread, which nobody sees unless that thread is
 * open, and a subagent helper's thread is hidden. So each ask also lands in
 * the notification feed (clicking it opens the thread, and session:resume
 * re-sends the prompt), and it is dismissed with a `notification.dismissed`
 * event when the ask settles: answered, denied, timed out, aborted or
 * canceled. A stale "needs your approval" never lingers. A restart loses
 * every pending ask, so boot sweeps their notifications too
 * ({@link dismissStaleAskNotifications}).
 *
 * Notification failures never touch the ask: every error is logged and
 * swallowed, and the prompt goes out whether or not its notification did.
 */

import { Agents } from '@snaglet/db/tables/agents';
import { Subagents } from '@snaglet/db/tables/subagents';
import type { ClarificationRequest, NotificationType } from '@snaglet/shared/types';
import { getErrorMessage, safeJsonParse, snippet } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { notificationService } from '@server/services/NotificationService';

/** Longest notification body an ask writes; the prompt in the thread has the rest. */
export const ASK_PREVIEW_CHARS = 200;

/** A notification announcing one parked ask. */
export interface AskNotification {
  /** The notification's id once it exists; null when creating it failed. */
  readonly notificationId: Promise<string | null>;
  /** The ask settled: dismiss its notification, once. Never rejects. */
  settle(): Promise<void>;
}

interface AskNotificationParams {
  type: NotificationType;
  title: string;
  body: string | null;
  threadId: string;
  agentId: string | null;
  runId: string | null;
}

/** Open asks by kind + thread + call id: one notification per ask. */
const openAsks = new Map<string, AskNotification>();

/** When this process loaded; the boot sweep leaves anything newer alone. */
const PROCESS_STARTED_AT = new Date();

function openAsk(key: string, build: () => Promise<AskNotificationParams>): AskNotification {
  const existing = openAsks.get(key);
  if (existing) return existing;

  const notificationId = build()
    .then((params) => notificationService.createAsk(params))
    .then((record) => record.id)
    .catch((err: unknown) => {
      logger.warn('[ask-notifications] could not create the notification for an ask', {
        key,
        error: getErrorMessage(err),
      });
      return null;
    });

  let settled: Promise<void> | null = null;
  const ask: AskNotification = {
    notificationId,
    settle() {
      if (settled) return settled;
      if (openAsks.get(key) === ask) openAsks.delete(key);
      // Waits for the create, so an ask answered before its notification was
      // written still clears it.
      settled = notificationId
        .then(async (id) => {
          if (id) await notificationService.dismiss(id);
        })
        .catch((err: unknown) => {
          logger.warn('[ask-notifications] could not dismiss the notification for an ask', {
            key,
            error: getErrorMessage(err),
          });
        });
      return settled;
    },
  };
  openAsks.set(key, ask);
  return ask;
}

/**
 * Who is asking, for the title: the agent's name, or for a subagent helper
 * "<orchestrator>'s subagent <helper>", since the user knows the helper only
 * through the agent that started it.
 */
async function describeAsker(agentId: string | null | undefined): Promise<string> {
  if (!agentId) return 'An agent';
  try {
    const agent = await Agents.findById(agentId);
    if (!agent) return 'An agent';
    if (!agent.parentAgentId) return agent.name;
    const [orchestrator, sub] = await Promise.all([
      Agents.findById(agent.parentAgentId),
      Subagents.findByAgentId(agent.id),
    ]);
    const helperName = sub?.name ?? agent.name;
    return orchestrator
      ? `${orchestrator.name}'s subagent ${helperName}`
      : `Subagent ${helperName}`;
  } catch (err) {
    logger.warn('[ask-notifications] asker name lookup failed', {
      agentId,
      error: getErrorMessage(err),
    });
    return 'An agent';
  }
}

export interface ToolApprovalAskInput {
  threadId: string;
  callId: string;
  agentId?: string;
  runId?: string | null;
  toolName: string;
  /** The prompt's own input summary; the body shows its start. */
  inputSummary: string;
}

/**
 * The approval body names the tool and its op only, never the arguments:
 * the body is stored and shown in OS banners (lock screen, notification
 * center), and a command or file write can carry a token or private text.
 * The prompt in the thread shows the full input.
 */
function approvalBody(toolName: string, inputSummary: string): string {
  const parsed = safeJsonParse<unknown>(inputSummary, null);
  const op =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).op
      : undefined;
  const what = typeof op === 'string' && op.trim() ? `${toolName} (${op.trim()})` : toolName;
  return snippet(`Wants to use ${what}. Open the thread to see the details.`, ASK_PREVIEW_CHARS);
}

/**
 * Announce a parked tool-permission prompt (either mode). For a subagent
 * helper, `threadId` is its hidden thread, so the notification opens it and
 * the prompt is re-sent there.
 */
export function notifyToolApprovalAsk(input: ToolApprovalAskInput): AskNotification {
  return openAsk(`tool:${input.threadId}:${input.callId}`, async () => ({
    type: 'tool_approval',
    title: `${await describeAsker(input.agentId)} needs your approval`,
    body: approvalBody(input.toolName, input.inputSummary),
    threadId: input.threadId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
  }));
}

export interface ClarificationAskInput {
  threadId: string;
  callId: string;
  agentId: string;
  runId?: string;
  request: ClarificationRequest;
}

/** The first question, and how many more the form holds. */
function describeQuestions(request: ClarificationRequest): string | null {
  const questions = request.questions ?? [];
  const first = questions[0]?.prompt?.trim() || request.preamble?.trim();
  if (!first) return null;
  const more = questions.length - 1;
  const suffix = more > 0 ? ` (+${more} more)` : '';
  return `${snippet(first, ASK_PREVIEW_CHARS - suffix.length)}${suffix}`;
}

/** Announce a parked Triage (`get_clarification`) question form. */
export function notifyClarificationAsk(input: ClarificationAskInput): AskNotification {
  return openAsk(`clarify:${input.threadId}:${input.callId}`, async () => ({
    // `mention`: the notification types are mirrored by a DB CHECK
    // (notifications_type_check), so a dedicated type would need a migration.
    // A Triage question is the agent addressing the user directly, which is
    // what `mention` means, and it already raises an OS alert.
    type: 'mention',
    title: `${await describeAsker(input.agentId)} needs your answer`,
    body: describeQuestions(input.request),
    threadId: input.threadId,
    agentId: input.agentId,
    runId: input.runId ?? null,
  }));
}

/**
 * Boot sweep: dismiss every ask notification left showing by an earlier
 * process. Pending asks live in memory, so none survived the restart; asks
 * this process raised before the sweep ran are newer than `startedAt` and
 * stay.
 */
export async function dismissStaleAskNotifications(
  startedAt: Date = PROCESS_STARTED_AT
): Promise<void> {
  try {
    const count = await notificationService.dismissStaleAsks(startedAt);
    if (count > 0) logger.info(`[ask-notifications] dismissed ${count} stale ask notification(s)`);
  } catch (err) {
    logger.warn('[ask-notifications] stale ask sweep failed', { error: getErrorMessage(err) });
  }
}
