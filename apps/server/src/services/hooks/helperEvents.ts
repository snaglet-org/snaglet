/**
 * Which bus events belong to a subagent helper.
 *
 * User-authored hooks never see a helper's own events: its thread's messages
 * and runs, its thread's lifecycle, its agent's lifecycle and tool
 * assignments. In-process listeners (notifications and the like) still get
 * every event; they apply their own rules. What a helper does to visible
 * work — a doc, a table row, a Board post, a signal — still fires as usual.
 */

import type { HookEvent } from '@server/services/HookService';
import {
  isHelperAgent,
  isHelperThread,
  isKnownHelperAgent,
  isKnownHelperThread,
} from '@server/services/subagents/helperVisibility';

/** Events whose `id` is the thread itself. */
const THREAD_SUBJECT_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'thread:create',
  'thread:update',
  'thread:delete',
  'thread:move',
]);

/** Events whose `id` is the agent itself. */
const AGENT_SUBJECT_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'agent:create',
  'agent:update',
  'agent:delete',
]);

/**
 * Events whose `agentId` is the agent the event is about (its run, its
 * message, its tool list). Elsewhere `agentId` names an actor or the first
 * participant of a visible thread, which does not make the event the helper's.
 */
const AGENT_OWNED_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'message:create',
  'run:end',
  'schedule:fire',
  'agent_tool:assign',
  'agent_tool:remove',
]);

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The thread and agent ids that make `payload` a helper's event when either is one. */
function subjectsOf(
  eventName: HookEvent,
  payload: unknown
): { threadIds: string[]; agentIds: string[] } {
  const record =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const threadIds: string[] = [];
  const agentIds: string[] = [];
  const threadId = stringField(record, 'threadId');
  if (threadId) threadIds.push(threadId);
  const id = stringField(record, 'id');
  if (id && THREAD_SUBJECT_EVENTS.has(eventName)) threadIds.push(id);
  if (id && AGENT_SUBJECT_EVENTS.has(eventName)) agentIds.push(id);
  const agentId = stringField(record, 'agentId');
  if (agentId && AGENT_OWNED_EVENTS.has(eventName)) agentIds.push(agentId);
  return { threadIds, agentIds };
}

/** True when `payload` is a helper's own event; such events skip user-authored hooks. */
export async function isHelperHookEvent(eventName: HookEvent, payload: unknown): Promise<boolean> {
  const { threadIds, agentIds } = subjectsOf(eventName, payload);
  const answers = await Promise.all([
    ...threadIds.map((id) => isHelperThread(id)),
    ...agentIds.map((id) => isHelperAgent(id)),
  ]);
  return answers.some(Boolean);
}

/**
 * Synchronous form for the bus's recent-event ring: true when the event is
 * already KNOWN to be a helper's (see isKnownHelperThread). The ring warms the
 * answer with {@link isHelperHookEvent} as it records each event.
 */
export function isKnownHelperHookEvent(eventName: HookEvent, payload: unknown): boolean {
  const { threadIds, agentIds } = subjectsOf(eventName, payload);
  return threadIds.some(isKnownHelperThread) || agentIds.some(isKnownHelperAgent);
}
