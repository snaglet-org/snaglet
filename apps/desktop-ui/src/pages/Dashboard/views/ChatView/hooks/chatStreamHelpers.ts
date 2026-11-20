import { isoNow } from '@snaglet/shared/utils';
import type { ThreadActivityLogRecord, ThreadMessage } from '@desktop/utils/api';
import { byCreatedAt } from '@desktop/utils/chronology';
import type { ActivityStep, RunActivity, StreamingMessage } from './types';

/**
 * Ids of the client-painted bubbles that stand in for a run until its
 * persisted row lands: the leftover of a `socket:done` that raced ahead of
 * the run's last `message_created`, and the live `socket:error` bubble.
 * The server has never seen either id.
 */
export const doneBubbleId = (agentId: string, runId: string): string => `done:${agentId}:${runId}`;
export const errorBubbleId = (agentId: string, runId: string): string =>
  `error:${agentId}:${runId}`;
export const isProvisionalId = (id: string): boolean =>
  id.startsWith('done:') || id.startsWith('error:');

export function makeStreamingMessage(
  threadId: string,
  agentId: string,
  runId: string
): StreamingMessage {
  return {
    id: `streaming:${agentId}:${runId}`,
    threadId,
    role: 'assistant',
    agentId,
    runId,
    content: '',
    thinkingContent: '',
    toolActivity: [],
    createdAt: isoNow(),
  };
}

export function makeRunActivity(threadId: string, agentId: string, runId: string): RunActivity {
  return {
    runId,
    agentId,
    threadId,
    steps: [],
    status: 'live',
    startedAt: isoNow(),
    finishedAt: null,
  };
}

/**
 * Append a chunk to the current pending thinking step. If the last step
 * isn't a live thinking step, start a new one.
 */
export function appendThinkingChunk(activity: RunActivity, chunk: string): RunActivity {
  const last = activity.steps[activity.steps.length - 1];
  if (last && last.kind === 'thinking' && last.live) {
    const updated: ActivityStep = { ...last, text: last.text + chunk };
    return { ...activity, steps: [...activity.steps.slice(0, -1), updated] };
  }
  const newStep: ActivityStep = {
    kind: 'thinking',
    id: `thinking:${activity.runId}:${activity.steps.length}`,
    text: chunk,
    live: true,
    createdAt: isoNow(),
  };
  return { ...activity, steps: [...activity.steps, newStep] };
}

/** Mark the current live thinking step as finalized (no more chunks coming). */
export function flushPendingThinking(activity: RunActivity): RunActivity {
  const last = activity.steps[activity.steps.length - 1];
  if (last && last.kind === 'thinking' && last.live) {
    return {
      ...activity,
      steps: [...activity.steps.slice(0, -1), { ...last, live: false }],
    };
  }
  return activity;
}

/**
 * Drop only the current live thinking step. Used when a provider stream is
 * retried: completed thinking/tool history from earlier iterations stays
 * intact, while reasoning from the failed in-flight attempt is discarded.
 */
export function discardPendingThinking(activity: RunActivity): RunActivity {
  const last = activity.steps[activity.steps.length - 1];
  if (last && last.kind === 'thinking' && last.live) {
    return { ...activity, steps: activity.steps.slice(0, -1) };
  }
  return activity;
}

/**
 * Group a flat list of activity-log rows (from the REST endpoint) by
 * runId, projecting each row into an ActivityStep. Skips rows whose
 * action_type isn't `thinking` or `tool_call` since those are the only
 * ones the bubble currently renders.
 */
export function groupActivityRows(rows: ThreadActivityLogRecord[]): Map<string, RunActivity> {
  const result = new Map<string, RunActivity>();
  // REST returns DESC by created_at; flip so steps are chronological.
  const chronological = [...rows].sort(byCreatedAt);
  for (const row of chronological) {
    if (!row.runId) continue;
    let activity = result.get(row.runId);
    if (!activity) {
      activity = {
        runId: row.runId,
        agentId: row.agentId,
        threadId: row.threadId,
        steps: [],
        status: row.runFinishedAt ? 'complete' : 'live',
        startedAt: row.runStartedAt || row.createdAt,
        finishedAt: row.runFinishedAt,
      };
    }
    if (row.actionType === 'thinking' && row.content) {
      activity.steps.push({
        kind: 'thinking',
        id: row.id,
        text: row.content,
        live: false,
        createdAt: row.createdAt,
      });
    } else if (row.actionType === 'tool_call' && row.tool) {
      const output = row.toolOutput as { output?: string; error?: string } | null;
      activity.steps.push({
        kind: 'tool_call',
        id: row.id,
        toolName: row.tool,
        input: row.toolInput ?? {},
        output: output?.output,
        error: output?.error,
        success: !output?.error,
        durationMs: row.durationMs ?? undefined,
        status: 'done',
        createdAt: row.createdAt,
      });
    }
    result.set(row.runId, activity);
  }
  return result;
}

/**
 * Fold a fresh activity-log snapshot into the live activity map after a
 * reconnect, when frames for runs that progressed or finished meanwhile were
 * never received.
 *
 * A run still live locally keeps its entry: the live stream owns it and the
 * log trails it. A run the snapshot calls live but the client already closed
 * also stays closed, since the log's finish stamp can lag `socket:done`. A
 * completed run is replaced only when the log holds steps the client missed.
 * Notes (model fallback) are never persisted, so they are carried over, and
 * final totals from `socket:done` win over the log's copy of them.
 */
export function mergeActivitySnapshot(
  prev: Map<string, RunActivity>,
  snapshot: Map<string, RunActivity>
): Map<string, RunActivity> {
  let next: Map<string, RunActivity> | null = null;
  for (const [runId, fetched] of snapshot) {
    const local = prev.get(runId);
    let merged: RunActivity | null = null;
    if (!local) {
      merged = fetched;
    } else if (local.status === 'complete' && fetched.status === 'complete') {
      const localNotes = local.steps.filter((step) => step.kind === 'note');
      if (fetched.steps.length > local.steps.length - localNotes.length) {
        merged = {
          ...fetched,
          steps: [...fetched.steps, ...localNotes].sort(byCreatedAt),
        };
      }
    }
    if (!merged) continue;
    next ??= new Map(prev);
    next.set(runId, merged);
  }
  return next ?? prev;
}

export function streamingToThreadMessage(s: StreamingMessage): ThreadMessage {
  return {
    id: s.id,
    threadId: s.threadId,
    role: s.role,
    agentId: s.agentId,
    runId: s.runId,
    content: s.content,
    createdAt: s.createdAt,
    thinkingContent: s.thinkingContent || null,
    toolActivity: s.toolActivity.length > 0 ? s.toolActivity : null,
  };
}

/**
 * A string that changes whenever a run's steps change in a way the reader
 * can see: a step added, thinking text growing, a tool call finishing. The
 * message list and the activity disclosure key their auto-scroll on it.
 */
export function activityStepsSignature(steps: ActivityStep[]): string {
  return steps
    .map((step) =>
      step.kind === 'thinking'
        ? `${step.id}:${step.text.length}:${step.live ? '1' : '0'}`
        : step.kind === 'note'
          ? `${step.id}:note`
          : [
              step.id,
              step.status,
              step.output?.length ?? 0,
              step.error?.length ?? 0,
              step.durationMs ?? 0,
            ].join(':')
    )
    .join('|');
}
