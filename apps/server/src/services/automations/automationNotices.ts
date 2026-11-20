/**
 * The four `automation` notifications. Each opens the thread
 * (threadId + agentId set). Creation and change notices are for agent-made
 * recurring automations only; one-off agent wakes and anything a person set
 * up stay quiet. Auto-pause and missed notices are always sent.
 */
import { getErrorMessage, snippet } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { notificationService } from '@server/services/NotificationService';

interface NoticeTarget {
  name: string;
  threadId: string;
  agentId: string;
}

function where(threadTitle: string | null): string {
  const title = threadTitle?.trim();
  return title ? `“${title}”` : 'an untitled thread';
}

async function send(target: NoticeTarget, title: string, body: string): Promise<void> {
  try {
    await notificationService.create({
      type: 'automation',
      title,
      body,
      threadId: target.threadId,
      agentId: target.agentId,
    });
  } catch (err) {
    logger.warn(`[automations] notification failed: ${getErrorMessage(err)}`);
  }
}

export function noticeScheduled(
  target: NoticeTarget,
  agentName: string,
  whenText: string,
  threadTitle: string | null
): Promise<void> {
  return send(
    target,
    `${agentName} scheduled "${target.name}"`,
    `${whenText} in ${where(threadTitle)}. Pause it from the calendar or the Automations view.`
  );
}

export function noticeChanged(target: NoticeTarget, agentName: string, whenText: string) {
  return send(target, `${agentName} changed "${target.name}"`, `Now ${whenText}.`);
}

export function noticeAutoPaused(target: NoticeTarget, failures: number, error: string) {
  return send(
    target,
    `"${target.name}" paused after ${failures} failed runs`,
    `Last error: ${snippet(error, 200) || 'unknown'}.`
  );
}

export function noticeMissed(target: NoticeTarget, at: Date, tz: string) {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
  return send(target, `Missed: "${target.name}"`, `Snaglet was off at ${time}. It didn't run.`);
}
