/**
 * thread ops `add_agents` and `remove_agents`: who is in a thread, kept apart
 * from `update` (the thread's settings) so a call that changes settings can
 * never take an agent out by accident. Taking yourself out is op `leave`
 * (threadLeave.ts) and nothing else: `remove_agents` refuses the caller's own
 * id.
 *
 * Both take `agent_ids` and an optional `id` (the thread; defaults to the
 * calling thread, required for external callers). Every check completes
 * before the first write, so a bad id never leaves a half-applied change.
 */
import { Threads, type ThreadRow } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Agents } from '@snaglet/db/tables/agents';
import { asNonEmptyString } from '@snaglet/shared/utils';
import { getCurrentActor } from '@server/realtime/actorContext';
import { emitThreadUpdated } from '@server/realtime/surfaces/threads';
import { hooks, type HookEventMap } from '@server/services/HookService';
import { emitParticipantAddedEvent } from '@server/services/SocketService/threadEvents';
import { markThreadRosterChanged } from '@server/services/SocketService/dispatch/rosterVersion';
import { participantAgentId } from '@server/domains/threads/handlers/participantAgentId';
import { removeAgentParticipant } from '@server/domains/threads/removeAgentParticipant';
import { perThreadSetup } from './perThreadSetup';
import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';
import {
  assertNotDmThread,
  resolveTargetThreadId,
  threadNotFoundError,
} from '@server/services/ToolService/lib/targetThread';

type UpdatedBy = HookEventMap['thread:update']['updatedBy'];

const ADD = 'thread op:add_agents';
const REMOVE = 'thread op:remove_agents';
const KEYS = new Set(['thread_id', 'agent_ids']);

function currentUpdatedBy(): UpdatedBy {
  const actor = getCurrentActor();
  return actor
    ? { kind: actor.actorKind, ...(actor.actorKind === 'system' ? {} : { id: actor.actorId }) }
    : { kind: 'system' };
}

/** `agent_ids`: required, non-empty, order kept, duplicates dropped. */
function parseAgentIds(input: Record<string, unknown>, label: string): string[] {
  const unknown = Object.keys(input).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label}: takes \`agent_ids\` and an optional id; unknown field(s): ${unknown.join(', ')}.`
    );
  }
  const raw = input.agent_ids;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id) => asNonEmptyString(id))) {
    throw new Error(`${label}: \`agent_ids\` must be a non-empty array of agent id strings.`);
  }
  return [...new Set(raw.map((id) => (id as string).trim()))];
}

/** The target thread, refusing a DM (it keeps both its parties) and a helper's thread. */
async function targetThread(
  input: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
  label: string,
  verb: 'added to' | 'removed from'
): Promise<ThreadRow> {
  const threadId = await resolveTargetThreadId(input, context, label);
  const thread = await Threads.findById(threadId);
  if (!thread) throw await threadNotFoundError(label, threadId, context);
  await assertNotDmThread(label, threadId, context, { allowOwnThread: false });
  // A subagent's thread belongs to that helper alone (same rule as the REST route).
  if (thread.parentThreadId) {
    throw new Error(`${label}: agents can't be ${verb} a subagent's thread.`);
  }
  return thread;
}

/** The same surfaces `update` reports on: the thread row event and the thread:update hook. */
function announce(
  thread: ThreadRow,
  changed: 'add_agents' | 'remove_agents',
  agentIds: string[]
): void {
  emitThreadUpdated({ id: thread.id, updatedAt: thread.updatedAt ?? thread.createdAt });
  hooks.emit('thread:update', {
    id: thread.id,
    updatedBy: currentUpdatedBy(),
    changed: [changed],
    participantAgentIds: changed === 'add_agents' ? agentIds : [],
    removedAgentIds: changed === 'remove_agents' ? agentIds : [],
  });
}

function threadLabel(thread: ThreadRow): string {
  return thread.title?.trim() || thread.id;
}

/**
 * Add agents to a thread. Agents already in it are skipped; an unknown id
 * refuses the whole call. The change is attributed to the ambient actor (an
 * agent, a person or an external MCP member) on the thread:update hook.
 */
export const threadAddAgents: ToolHandler = async (input, _settings, context) => {
  const requested = parseAgentIds(input, ADD);
  const thread = await targetThread(input, context, ADD, 'added to');
  const threadId = thread.id;

  const found = await Promise.all(
    requested.map(async (id) => ({ id, agent: await Agents.findById(id) }))
  );
  const unknown = found.filter((entry) => !entry.agent).map((entry) => entry.id);
  if (unknown.length > 0) {
    throw new Error(`${ADD}: agent(s) not found: ${unknown.join(', ')} — nothing was changed.`);
  }
  const added: { id: string; name: string | null }[] = [];
  for (const { id, agent } of found) {
    if (!agent) continue;
    if (await ThreadParticipants.isAgentParticipant(threadId, id)) continue;
    added.push({ id, name: agent.name ?? null });
  }

  for (const agent of added) {
    await ThreadParticipants.addParticipant({ threadId, agentId: agent.id });
    void emitParticipantAddedEvent(threadId, agent.id, agent.name ?? undefined);
  }
  const addedIds = added.map(({ id }) => id);
  if (added.length > 0) {
    // A run going on in this thread re-reads its roster before it next routes
    // mentions, so an @-mention in this same turn wakes them.
    markThreadRosterChanged(threadId);
    announce(thread, 'add_agents', addedIds);
  }

  // Added to the thread the caller is running in: a mention in its reply wakes them.
  const addedHere = added.length > 0 && !!context?.agentId && context.threadId === threadId;
  const mentionLine = addedHere
    ? `\nMention ${added.map(({ id, name }) => `@${name ?? id}`).join(', ')} in your reply to wake them.`
    : '';
  return {
    output:
      (added.length > 0
        ? `Added agents to thread '${threadLabel(thread)}' (id=${threadId}): ${addedIds.join(', ')}`
        : `Nothing changed: every agent was already in thread '${threadLabel(thread)}' (id=${threadId}).`) +
      mentionLine,
    rawContent: {
      thread_id: threadId,
      added_agent_ids: addedIds,
      updated_by: currentUpdatedBy(),
    },
  };
};

/**
 * Settle a removal before anything is written. Removal is housekeeping in
 * your own room: only an agent that is in the thread may do it, it may take
 * out any other agent (a specialist whose part is done), never itself (that
 * is op `leave`), never a person, and never an agent a person set up for this
 * thread (perThreadSetup). The caller stays, so the thread always keeps an
 * agent. Every problem is named in one error.
 */
async function checkRemovals(
  threadId: string,
  removeIds: readonly string[],
  callerAgentId: string | undefined
): Promise<void> {
  if (!callerAgentId) {
    throw new Error(
      `${REMOVE}: only an agent in the thread can remove agents — nothing was changed.`
    );
  }
  if (removeIds.includes(callerAgentId)) {
    throw new Error(
      `${REMOVE}: you can't remove yourself. To take yourself out, use op "leave" — nothing was changed.`
    );
  }
  const participants = await ThreadParticipants.listByThread(threadId);
  const agentIds = participants
    .map((participant) => participantAgentId(participant))
    .filter((id): id is string => id !== null);
  if (!agentIds.includes(callerAgentId)) {
    throw new Error(
      `${REMOVE}: you can only remove agents from a thread you are in, and you are not in ${threadId} — nothing was changed.`
    );
  }
  const people = participants.filter((participant) => participant.kind === 'user');
  const isPerson = (id: string) =>
    people.some(
      (person) =>
        person.id === id ||
        person.memberId === id ||
        (person.userId ?? (person as { user_id?: string | null }).user_id) === id
    );

  const problems: string[] = [];
  const persons = removeIds.filter((id) => isPerson(id));
  if (persons.length > 0) {
    problems.push(`${persons.join(', ')}: a person, not an agent (only agents can be removed)`);
  }
  const absent = removeIds.filter((id) => !isPerson(id) && !agentIds.includes(id));
  if (absent.length > 0) problems.push(`${absent.join(', ')}: not an agent in this thread`);
  for (const id of removeIds) {
    const row = participants.find((participant) => participantAgentId(participant) === id);
    if (!row) continue;
    const setup = await perThreadSetup(threadId, id, row);
    if (setup.length > 0) {
      problems.push(
        `${id} has per-thread settings here (${setup.join(', ')}); a person removes them in the app`
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`${REMOVE}: can't remove ${problems.join('; ')} — nothing was changed.`);
  }
}

/**
 * Remove other agents from a thread the caller is in, through the same
 * removal as the app's Remove button (row, skill picks, roster line).
 */
export const threadRemoveAgents: ToolHandler = async (input, _settings, context) => {
  const removeIds = parseAgentIds(input, REMOVE);
  const thread = await targetThread(input, context, REMOVE, 'removed from');
  const threadId = thread.id;
  await checkRemovals(threadId, removeIds, context?.agentId);

  // The tool call itself is already in the activity log, so no actor is passed.
  const removed: string[] = [];
  for (const agentId of removeIds) {
    if (await removeAgentParticipant({ threadId, agentId })) removed.push(agentId);
  }
  if (removed.length > 0) announce(thread, 'remove_agents', removed);
  return {
    output:
      removed.length > 0
        ? `Removed agents from thread '${threadLabel(thread)}' (id=${threadId}): ${removed.join(', ')}`
        : `Nothing changed: none of those agents was still in thread '${threadLabel(thread)}' (id=${threadId}).`,
    rawContent: {
      thread_id: threadId,
      removed_agent_ids: removed,
      updated_by: currentUpdatedBy(),
    },
  };
};
