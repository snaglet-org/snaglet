import { getDb } from '@snaglet/db';
import { TableEntries } from '@snaglet/db/tables/table_entries';
import type { HookEventMap } from '@server/services/HookService';
import { buildAgentCreateEvent } from './agentCreateEvent';
import { buildThreadCreateEvent } from './threadCreateEvent';
import type { HookRunContext } from './hookRunner';
import { AppError, generateId, userTimeZone } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS, TABLE_HISTORY_ACTOR_KINDS } from '@snaglet/shared/types';

export interface HookInvocationInput {
  nodeIds?: string | string[];
  /** table_entry:* events: the Database table and the entry in it to resolve. */
  tableId?: string;
  entryId?: string;
  eventName?: string;
  event?: Record<string, unknown>;
}

export interface ResolvedHookInvocation {
  nodeId: string | null;
  eventName: string;
  event: Record<string, unknown>;
  context: HookRunContext;
}

function validation(message: string): never {
  throw new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

async function resolveMessage(id: string): Promise<ResolvedHookInvocation> {
  const { rows } = await getDb().query<{
    id: string;
    thread_id: string;
    role: string;
    agent_id: string | null;
    content: string;
  }>(`SELECT id, thread_id, role, agent_id, content FROM messages WHERE id=$1`, [id]);
  const row = rows[0];
  if (!row) validation(`Message not found: ${id}`);
  const event: HookEventMap['message:create'] = {
    id: row.id,
    threadId: row.thread_id,
    role: row.role === 'assistant' ? 'agent' : 'user',
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    text: row.content,
    chars: row.content.length,
  };
  return {
    nodeId: id,
    eventName: 'message:create',
    event,
    context: { agentId: row.agent_id ?? undefined, threadId: row.thread_id, triggerMessageId: id },
  };
}

async function resolveThread(id: string): Promise<ResolvedHookInvocation> {
  // Same builder the real emit sites use, so a test run delivers exactly
  // the payload a live thread:create would (roster, models, prompts).
  // createdBy is the ambient actor — the user pressing Run test.
  const event = await buildThreadCreateEvent(id);
  if (!event) validation(`Thread not found: ${id}`);
  return {
    nodeId: id,
    eventName: 'thread:create',
    event,
    context: { agentId: event.agentId, threadId: id },
  };
}

const TABLE_ENTRY_EVENTS = new Set<string>([
  'table_entry:create',
  'table_entry:update',
  'table_entry:delete',
  'table_entry:occurrence',
]);

/**
 * A `table_entry:occurrence` sample from the entry's newest occurrence log
 * row, as if that action had just happened (`via: 'action'`, by whoever
 * logged it); `current` and `ended` are the repeat as it stands.
 */
async function occurrenceSample(
  tableId: string,
  entryId: string,
  entryName: string
): Promise<HookEventMap['table_entry:occurrence']> {
  const view = await TableEntries.entryRepeats(tableId, entryId);
  const row = view.log[0]; // newest first
  if (!row)
    validation(
      `Table entry ${entryId} has no logged occurrence yet; mark one done or skipped first`
    );
  const repeat = view.repeats[row.fieldId] ?? null;
  const log = view.log.filter((candidate) => candidate.fieldId === row.fieldId);
  // Ended: the row's current (last) occurrence is finished, as the model reads it.
  const ended = log.some(
    (candidate) =>
      candidate.occurrence === repeat?.current &&
      (candidate.kind === 'done' || candidate.kind === 'skipped')
  );
  const actorKind = TABLE_HISTORY_ACTOR_KINDS.find((kind) => kind === row.actorKind);
  return {
    tableId,
    entryId,
    fieldId: row.fieldId,
    entryName,
    action: row.kind,
    occurrence: row.occurrence,
    lastOccurrence: row.occurrence,
    count: 1,
    tz: repeat?.tz ?? userTimeZone(),
    movedTo: row.movedTo,
    undoneAction: null,
    current: repeat?.current ?? null,
    ended,
    logId: row.id,
    logIds: [row.id],
    via: 'action',
    actor:
      actorKind && row.actorId
        ? { kind: actorKind, id: row.actorId }
        : { kind: 'system', id: 'system' },
  };
}

/**
 * A table entry resolves into the payload its real table_entry event carries.
 * The update sample lists every set field as a change from null to its
 * current value, so a hook's filter/handler sees the real `changes` shape;
 * the occurrence sample is built from the row's newest log row.
 */
async function resolveTableEntry(
  tableId: string,
  entryId: string,
  requestedEvent?: string
): Promise<ResolvedHookInvocation> {
  const eventName = requestedEvent ?? 'table_entry:update';
  if (!TABLE_ENTRY_EVENTS.has(eventName))
    validation(`${eventName} cannot be created from a table entry; pass a node id instead`);
  let entry: Awaited<ReturnType<typeof TableEntries.getEntry>>;
  try {
    entry = await TableEntries.getEntry(tableId, entryId);
  } catch {
    validation(`Table entry not found: ${entryId} in ${tableId}`);
  }
  let event: Record<string, unknown>;
  if (eventName === 'table_entry:create') {
    event = { tableId, entryId } satisfies HookEventMap['table_entry:create'];
  } else if (eventName === 'table_entry:delete') {
    event = { tableId, entryIds: [entryId] } satisfies HookEventMap['table_entry:delete'];
  } else if (eventName === 'table_entry:occurrence') {
    const named = await TableEntries.resolveEntries([{ tableId, entryId }]);
    event = { ...(await occurrenceSample(tableId, entryId, named.entries[0]?.name ?? '')) };
  } else {
    const changes = Object.entries(entry.entry.values)
      .filter(([, value]) => value !== null)
      .map(([field, value]) => ({ field, from: null, to: value }));
    event = { tableId, entryId, changes } satisfies HookEventMap['table_entry:update'];
  }
  return { nodeId: entryId, eventName, event, context: {} };
}

async function resolveAgent(id: string, eventName: string): Promise<ResolvedHookInvocation> {
  // agent:create delivers the full configuration payload via the same
  // builder the live emit uses; update/delete stay minimal, matching
  // their real wire shapes.
  if (eventName === 'agent:create') {
    const event = await buildAgentCreateEvent(id);
    if (!event) validation(`Agent not found: ${id}`);
    return { nodeId: id, eventName, event, context: { agentId: id } };
  }
  const { rows } = await getDb().query<{ id: string }>(`SELECT id FROM agents WHERE id=$1`, [id]);
  if (!rows[0]) validation(`Agent not found: ${id}`);
  return {
    nodeId: id,
    eventName,
    event: eventName === 'agent:update' ? { id, changed: ['manual-test'] } : { id },
    context: { agentId: id },
  };
}

async function resolveRun(id: string): Promise<ResolvedHookInvocation> {
  const { rows } = await getDb().query<{
    id: string;
    agent_id: string | null;
    thread_id: string | null;
    status: HookEventMap['run:end']['status'];
  }>(`SELECT id, agent_id, thread_id, status FROM runs WHERE id=$1`, [id]);
  const row = rows[0];
  if (!row) validation(`Run not found: ${id}`);
  return {
    nodeId: id,
    eventName: 'run:end',
    event: {
      runId: row.id,
      status: row.status,
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
    },
    context: { agentId: row.agent_id ?? undefined, threadId: row.thread_id ?? undefined },
  };
}

type LifecycleEventName =
  | 'doc:create'
  | 'doc:edit'
  | 'doc:move'
  | 'doc:rename'
  | 'container:create'
  | 'container:move'
  | 'container:update'
  | 'thread:move'
  | 'node:archive'
  | 'node:restore';

async function resolveLifecycle(
  id: string,
  type: string,
  eventName: LifecycleEventName
): Promise<ResolvedHookInvocation> {
  const { rows } = await getDb().query<{
    id: string;
    type: string;
    title: string | null;
    category: string | null;
    container_id: string | null;
    project_id: string | null;
    parent_id: string | null;
    created_by: string | null;
    last_edited_by: string | null;
    content_length: number | null;
    archived: boolean;
    archived_at: string | null;
  }>(
    `SELECT n.id, n.type::text AS type, COALESCE(d.title, c.name, t.title) AS title,
            c.category::text AS category, n.container_id, n.project_id,
            c.parent_id, d.created_by, d.last_edited_by,
            CASE WHEN d.id IS NULL THEN NULL ELSE length(d.content) END AS content_length,
            n.archived, n.archived_at::text
       FROM nodes n
       LEFT JOIN docs d ON d.id=n.id
       LEFT JOIN containers c ON c.id=n.id
       LEFT JOIN threads t ON t.id=n.id
      WHERE n.id=$1`,
    [id]
  );
  const row = rows[0];
  if (!row) validation(`Workspace node not found: ${id}`);
  let event: Record<string, unknown>;
  if (eventName === 'doc:create') {
    if (type !== 'doc') validation(`Cannot create ${eventName} from ${type} node ${id}`);
    event = {
      id,
      title: row.title ?? '',
      parentContainerId: row.container_id,
      createdBy: row.created_by,
    };
  } else if (eventName === 'doc:edit') {
    if (type !== 'doc') validation(`Cannot create ${eventName} from ${type} node ${id}`);
    event = { id, editor: row.last_edited_by, charsDelta: 0, backupSnapshotId: null };
  } else if (eventName === 'doc:move') {
    if (type !== 'doc') validation(`Cannot create ${eventName} from ${type} node ${id}`);
    event = { id, fromContainerId: row.container_id, toContainerId: row.container_id };
  } else if (eventName === 'doc:rename') {
    if (type !== 'doc') validation(`Cannot create ${eventName} from ${type} node ${id}`);
    event = { id, oldTitle: row.title ?? '', newTitle: row.title ?? '' };
  } else if (eventName === 'container:create') {
    if (type !== 'container') validation(`Cannot create ${eventName} from ${type} node ${id}`);
    event = { id, name: row.title ?? '', category: row.category, parentId: row.parent_id };
  } else if (eventName === 'container:move') {
    if (type !== 'container') validation(`Cannot create ${eventName} from ${type} node ${id}`);
    event = { id, fromParentId: row.parent_id, toParentId: row.parent_id };
  } else if (eventName === 'container:update') {
    if (type !== 'container') validation(`Cannot create ${eventName} from ${type} node ${id}`);
    event = { id, changed: [] };
  } else if (eventName === 'thread:move') {
    if (type !== 'thread') validation(`Cannot create ${eventName} from ${type} node ${id}`);
    // A sample move stays within the thread's current project; the
    // container-named fields are deprecated aliases of the project fields.
    event = {
      id,
      fromProjectId: row.project_id,
      toProjectId: row.project_id,
      fromContainerId: row.project_id,
      toContainerId: row.project_id,
    };
  } else {
    const archivedAt = row.archived_at;
    const { rows: cohort } = archivedAt
      ? await getDb().query<{ id: string }>(
          `SELECT id FROM nodes WHERE archived_at=$1 ORDER BY id`,
          [archivedAt]
        )
      : { rows: [{ id }] };
    const cohortIds = cohort.map((item) => item.id);
    event = { rootId: id, rootKind: type, cohortIds, count: cohortIds.length, archivedBy: null };
  }
  return { nodeId: id, eventName, event, context: type === 'thread' ? { threadId: id } : {} };
}

async function resolveId(id: string, requestedEvent?: string): Promise<ResolvedHookInvocation> {
  if (requestedEvent?.startsWith('agent:')) return resolveAgent(id, requestedEvent);
  if (requestedEvent === 'run:end') return resolveRun(id);
  const { rows } = await getDb().query<{ type: string }>(
    `SELECT type::text AS type FROM nodes WHERE id=$1 AND archived=false`,
    [id]
  );
  const type = rows[0]?.type;
  if (!type) validation(`Workspace node not found: ${id}`);
  const lifecycleEvents = new Set<string>([
    'doc:create',
    'doc:edit',
    'doc:move',
    'doc:rename',
    'container:create',
    'container:move',
    'container:update',
    'thread:move',
    'node:archive',
    'node:restore',
  ]);
  if (requestedEvent && lifecycleEvents.has(requestedEvent)) {
    return resolveLifecycle(id, type, requestedEvent as LifecycleEventName);
  }
  if (type === 'message' && (!requestedEvent || requestedEvent === 'message:create')) {
    return resolveMessage(id);
  }
  if (type === 'thread' && (!requestedEvent || requestedEvent === 'thread:create')) {
    return resolveThread(id);
  }
  validation(
    `Cannot create ${requestedEvent ?? 'a hook event'} from ${type} node ${id}; pass an explicit event object instead`
  );
}

export async function resolveHookInvocations(
  hookName: string,
  input: HookInvocationInput
): Promise<ResolvedHookInvocation[]> {
  const rawIds =
    input.nodeIds == null ? [] : Array.isArray(input.nodeIds) ? input.nodeIds : [input.nodeIds];
  const nodeIds = rawIds.map((id) => id.trim()).filter(Boolean);
  if (nodeIds.length > 100) validation('A hook run accepts at most 100 node IDs');
  if (nodeIds.length > 0 && input.event) validation('Pass nodeIds or event, not both');
  const tableId = typeof input.tableId === 'string' ? input.tableId.trim() : '';
  const entryId = typeof input.entryId === 'string' ? input.entryId.trim() : '';
  if (tableId || entryId) {
    if (!tableId || !entryId) validation('Pass both tableId and entryId for a table entry event');
    if (nodeIds.length > 0) validation('Pass nodeIds or a table entry, not both');
    if (input.event) validation('Pass a table entry or event, not both');
    return [await resolveTableEntry(tableId, entryId, input.eventName)];
  }
  if (nodeIds.length > 0) {
    const resolved: ResolvedHookInvocation[] = [];
    for (const id of nodeIds) resolved.push(await resolveId(id, input.eventName));
    return resolved;
  }

  const eventName = input.eventName ?? 'schedule:fire';
  if (input.event) {
    return [{ nodeId: null, eventName, event: input.event, context: {} }];
  }
  if (eventName !== 'schedule:fire') {
    validation(`event is required when running ${eventName} without nodeIds`);
  }
  const runId = generateId('manual_hook_run');
  return [
    {
      nodeId: null,
      eventName,
      event: {
        scheduleId: `manual:${hookName}`,
        runId,
        scheduledFor: new Date().toISOString(),
      },
      context: {},
    },
  ];
}
