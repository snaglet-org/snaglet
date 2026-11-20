/**
 * notificationHooks — turns `run:end` events into in-app notifications:
 * `failed` -> `run_failed`; `completed` whose reply is a question
 * (`message_type = 'question'`) -> one `mention` instead of `run_completed`;
 * other `completed` -> `run_completed`. A subagent helper's run raises none
 * (it reports to its orchestrator). Asks that block a run are announced by
 * askNotifications instead. A thread can also opt in to a per-run alert (OS
 * banner + sound, see {@link alertThreadRunEnd}), a separate
 * `thread.run_alert` event rather than a second tray entry.
 */

import { hooks, type HookEventMap } from '@server/services/HookService';
import { notificationService } from '@server/services/NotificationService';
import { ASK_PREVIEW_CHARS } from '@server/services/askNotifications';
import { logger } from '@server/config/logger';
import { getErrorMessage, snippet } from '@snaglet/shared/utils';
import { Agents } from '@snaglet/db/tables/agents';
import { Messages } from '@snaglet/db/tables/messages';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadNotificationSettingsTable } from '@snaglet/db/tables/thread_notification_settings';
import type { NotificationType, ThreadRunAlert, ThreadRunAlertStatus } from '@snaglet/shared/types';
import { emitThreadRunAlert } from '@server/realtime/surfaces/threadNotifications';

/**
 * Resolve an agent's display name from its id, tolerating lookup failure.
 * Falls back to the raw id (or a generic label) so a notification is never
 * blank — the user must be able to tell which agent and which thread an
 * event refers to.
 */
async function resolveAgentName(agentId: string | null | undefined): Promise<string | null> {
  if (!agentId) return null;
  try {
    const row = await Agents.findById(agentId);
    return row?.name ?? agentId;
  } catch (err) {
    logger.warn('[notification-hooks] agent name lookup failed', {
      agentId,
      error: getErrorMessage(err),
    });
    return agentId;
  }
}

/**
 * Resolve a thread's title from its id. Threads may be untitled, so this
 * returns null when there is no human-readable title and the caller phrases
 * around it (e.g. "in an untitled thread").
 */
async function resolveThreadTitle(threadId: string | null | undefined): Promise<string | null> {
  if (!threadId) return null;
  try {
    const row = await Threads.findById(threadId);
    const title = row?.title?.trim();
    return title ? title : null;
  } catch (err) {
    logger.warn('[notification-hooks] thread title lookup failed', {
      threadId,
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * The question this run ended on, if any: the agent's latest reply in the
 * thread, when this run wrote it and it was classified as a question. A
 * lookup failure answers "no question", so the run still notifies.
 */
async function findQuestionReply(payload: HookEventMap['run:end']): Promise<string | null> {
  if (!payload.threadId || !payload.agentId) return null;
  try {
    const reply = await Messages.findLatestAgentReply(payload.threadId, payload.agentId);
    if (!reply || reply.runId !== payload.runId || reply.messageType !== 'question') return null;
    return reply.content;
  } catch (err) {
    logger.warn('[notification-hooks] question reply lookup failed', {
      runId: payload.runId,
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * Turn one run end into at most one notification. Both kinds name the agent
 * and thread involved: the payload only carries ids, so display names are
 * resolved first, then built into a sentence that reads cleanly whether or
 * not a name/title is available.
 */
export async function notifyRunEnd(payload: HookEventMap['run:end']): Promise<void> {
  if (payload.status !== 'failed' && payload.status !== 'completed') return;

  const [agentName, threadTitle, question] = await Promise.all([
    resolveAgentName(payload.agentId),
    resolveThreadTitle(payload.threadId),
    payload.status === 'completed' ? findQuestionReply(payload) : Promise.resolve(null),
  ]);

  const who = agentName ?? 'An agent';
  const where = threadTitle ? `\u201c${threadTitle}\u201d` : 'an untitled thread';

  let type: NotificationType;
  let title: string;
  let body: string | null;

  if (payload.status === 'failed') {
    type = 'run_failed';
    title = agentName ? `${agentName} failed` : 'Agent run failed';
    body = `${who} failed in ${where}.`;
  } else if (question !== null) {
    // `mention`: notification types are mirrored by a DB CHECK
    // (notifications_type_check), so a dedicated "question" type would need a
    // migration. A reply that asks the user something addresses them
    // directly, which is what `mention` means, and it raises an OS alert,
    // which a plain run_completed does not.
    type = 'mention';
    title = `${who} has a question for you`;
    body = snippet(question, ASK_PREVIEW_CHARS) || null;
  } else {
    type = 'run_completed';
    title = agentName ? `${agentName} completed` : 'Agent run completed';
    body = `${who} finished in ${where}.`;
  }

  const record = await notificationService.create({
    type,
    title,
    body,
    threadId: payload.threadId ?? null,
    agentId: payload.agentId ?? null,
    runId: payload.runId,
  });

  // The thread's own "tell me when a run ends here" setting. Separate from the
  // tray entry above, which stays the single tray entry for this run: this
  // only adds the banner + sound, and only when the thread asked for it.
  //
  // A null record means NotificationService dropped it as a subagent helper's
  // run, which is deliberately never announced to the user (it reports to its
  // orchestrator). The alert follows that rule rather than talking over it, so
  // a helper thread stays silent even if a row somehow enabled it — which is
  // also why the settings tab is hidden for helper threads.
  if (!record) return;

  await alertThreadRunEnd({
    threadId: payload.threadId ?? null,
    runId: payload.runId,
    status: payload.status,
    title,
    body,
    notificationId: record.id,
  });
}

/**
 * Raise the per-thread run-ended alert when this thread's settings ask for it
 * and the status matches, reusing the tray notification's wording. Silent for
 * an aborted run, a thread with no settings row (opt-in), a run with no
 * thread, and a subagent helper's run. `notificationId` ties the alert to the
 * run's tray entry. Best effort: failures are logged and swallowed so they
 * can never fail the run.
 */
async function alertThreadRunEnd(params: {
  threadId: string | null;
  runId: string;
  status: ThreadRunAlertStatus;
  title: string;
  body: string | null;
  notificationId: string;
}): Promise<void> {
  if (!params.threadId) return;
  try {
    const settings = await ThreadNotificationSettingsTable.get(params.threadId);
    if (!settings?.enabled) return;
    const wanted = params.status === 'failed' ? settings.onFailed : settings.onCompleted;
    if (!wanted) return;

    const alert: ThreadRunAlert = {
      threadId: params.threadId,
      runId: params.runId,
      status: params.status,
      sound: settings.sound,
      title: params.title,
      body: params.body,
      notificationId: params.notificationId,
    };
    emitThreadRunAlert(alert);
  } catch (err) {
    logger.error('[notification-hooks] thread run alert failed', {
      threadId: params.threadId,
      runId: params.runId,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Register all notification-producing event listeners. Call once at boot.
 * Idempotent guard prevents double-registration.
 */
let registered = false;

export function registerNotificationHooks(): void {
  if (registered) return;
  registered = true;

  // Run end (completed / question / failed)
  hooks.on('run:end', (payload) => {
    notifyRunEnd(payload).catch((err: unknown) => {
      logger.error('[notification-hooks] failed to create run:end notification', {
        status: payload.status,
        error: getErrorMessage(err),
      });
    });
  });

  logger.info('[notification-hooks] registered');
}
