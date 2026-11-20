/**
 * Undo history for custom tables, per actor: the human user (by users.id),
 * each agent (by agents.id) and each external MCP client (by members.id) has
 * its own linear stack of the newest 100 steps. Every table write records
 * under the ambient actor (`getCurrentActor`), so agent tool calls land in
 * the agent's stack and HTTP requests in the user's; with no actor bound,
 * writes record under `system`.
 *
 * Undo reverts the stack's newest done step and redo re-applies its oldest
 * undone one; both refuse (409) rather than overwrite anything changed since.
 * A person may step an agent's stack by naming it.
 */
import {
  TableHistory,
  takePurgeRequest,
  type HistoryActor,
  type HistoryContext,
  type StepEffects,
  type StepOutcome,
} from '@snaglet/db/tables/table_history';
import {
  TABLE_HISTORY_ACTOR_KINDS,
  TABLE_HISTORY_DEPTH,
  TABLE_CATALOG_ID_PATTERN,
  type TableHistoryActor,
  type TableHistoryActorKind,
  type TableHistoryResponse,
  type TableHistoryStepResponse,
} from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { getCurrentActor } from '@server/realtime/actorContext';
import {
  emitTableEntriesChanged,
  emitTableFieldsChanged,
  emitTableHistoryChanged,
  emitTableRemoved,
  emitTableRestored,
  emitTableUpdated,
} from '@server/realtime/surfaces/tables';
import { emitOccurrenceEvents, occurrenceEvents } from './tableOccurrenceEvents';
import { tableBadRequest } from './tableValidation';

const SYSTEM_ACTOR: HistoryActor = { kind: 'system', id: 'system', name: 'system' };

/** The ambient actor whose stack a write records into. */
function historyActor(): HistoryActor {
  const actor = getCurrentActor();
  if (!actor) return SYSTEM_ACTOR;
  return { kind: actor.actorKind, id: actor.actorId, name: actor.actorName ?? null };
}

export function historyContext(): HistoryContext {
  return { actor: historyActor() };
}

/**
 * After a write that may have recorded a step: tell clients showing the
 * actor's stack, and drop deleted data whose step left the history. Never
 * fails the request; a failed purge is retried by the next one.
 */
export async function afterTableWrite(actor: HistoryActor = historyActor()): Promise<void> {
  emitTableHistoryChanged({ kind: actor.kind, id: actor.id });
  if (takePurgeRequest()) await purgeReleasedTableData();
}

export async function purgeReleasedTableData(): Promise<void> {
  try {
    const result = await TableHistory.purgeReleased();
    // Steps that needed what was dropped left those stacks too.
    for (const actor of result.actors) emitTableHistoryChanged({ kind: actor.kind, id: actor.id });
    if (result.tables.length || result.fields.length)
      logger.info('Purged deleted table data that left the undo history', {
        tables: result.tables,
        fields: result.fields,
      });
    if (result.errors.length)
      logger.warn('Some deleted table data could not be purged yet', { errors: result.errors });
  } catch (error) {
    logger.warn(`Table history purge failed: ${getErrorMessage(error)}`);
  }
}

function object(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw tableBadRequest('Request must be an object.');
  return input as Record<string, unknown>;
}

function actorKind(value: unknown): TableHistoryActorKind {
  const kind = TABLE_HISTORY_ACTOR_KINDS.find((candidate) => candidate === value);
  if (!kind)
    throw tableBadRequest(`actor.kind must be one of ${TABLE_HISTORY_ACTOR_KINDS.join(', ')}.`);
  return kind;
}

function actorId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw tableBadRequest('actor.id must be the actor id.');
  return value.trim();
}

/** The stack a request names (`{ kind, id }`), or the caller's own. */
function requestedActor(input: unknown): HistoryActor {
  if (input === undefined || input === null) return historyActor();
  const raw = object(input);
  return { kind: actorKind(raw.kind), id: actorId(raw.id) };
}

function limitOf(value: unknown): number {
  if (value === undefined) return TABLE_HISTORY_DEPTH;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > TABLE_HISTORY_DEPTH
  )
    throw tableBadRequest(`limit must be between 1 and ${TABLE_HISTORY_DEPTH}.`);
  return number;
}

/**
 * GET /api/tables/history. Query: `actorKind` + `actorId` for another stack
 * (default: the caller's), or `actor=all` for the newest steps of every actor
 * (optionally `tableId`); `limit` 1–100.
 */
export async function listTableHistory(input: unknown = {}): Promise<TableHistoryResponse> {
  const query = object(input);
  const limit = limitOf(query.limit);
  if (query.actor === 'all') {
    const tableId = query.tableId;
    if (
      tableId !== undefined &&
      (typeof tableId !== 'string' || !TABLE_CATALOG_ID_PATTERN.test(tableId))
    )
      throw tableBadRequest('tableId must be a table id.');
    return {
      actor: null,
      steps: await TableHistory.recent(limit, tableId),
      undo: null,
      redo: null,
      depth: TABLE_HISTORY_DEPTH,
    };
  }
  if (query.actor !== undefined) throw tableBadRequest('actor must be "all" when given.');
  const actor: HistoryActor =
    query.actorKind === undefined && query.actorId === undefined
      ? historyActor()
      : { kind: actorKind(query.actorKind), id: actorId(query.actorId) };
  const stack = await TableHistory.stack(actor, limit);
  const named: TableHistoryActor = {
    kind: actor.kind,
    id: actor.id,
    name: actor.name ?? stack.steps[0]?.actor.name ?? null,
  };
  return { actor: named, ...stack, depth: TABLE_HISTORY_DEPTH };
}

function names(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const raw = object(value);
  const result: Record<string, string> = {};
  for (const [id, name] of Object.entries(raw)) {
    if (typeof name !== 'string')
      throw tableBadRequest('names must map field or table ids to names.');
    Object.defineProperty(result, id, {
      value: name,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function isDiscarded(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  const details = error.details;
  return !!details && !Array.isArray(details) && details.reason === 'discarded';
}

/** Emit what an undo or redo changed, once per table, after commit. */
function emitStepEffects(effects: StepEffects): void {
  for (const [, { table, change }] of effects.tables) {
    if (change === 'removed' && table.state) emitTableRemoved(table.id, table.state);
    else if (change === 'restored') emitTableRestored(table);
    else if (change === 'renamed') emitTableUpdated(table);
  }
  // A removed or restored table reloads (or drops) whole; fields.changed also reloads entries.
  const whole = (tableId: string) => {
    const change = effects.tables.get(tableId)?.change;
    return change === 'removed' || change === 'restored';
  };
  for (const tableId of effects.fields) if (!whole(tableId)) emitTableFieldsChanged(tableId);
  for (const [tableId, ids] of effects.entries)
    if (!whole(tableId) && !effects.fields.has(tableId)) emitTableEntriesChanged(tableId, [...ids]);
}

/** POST /api/tables/history/undo and /redo. */
export async function stepTableHistory(
  direction: 'undo' | 'redo',
  input: unknown = {}
): Promise<TableHistoryStepResponse> {
  const body = object(input);
  const actor = requestedActor(body.actor);
  const stepId = body.stepId;
  if (stepId !== undefined && (typeof stepId !== 'string' || !stepId.trim()))
    throw tableBadRequest('stepId must be a history step id.');
  let outcome: StepOutcome;
  try {
    outcome = await TableHistory.step(actor, direction, {
      ...(typeof stepId === 'string' ? { stepId } : {}),
      ...(body.names !== undefined ? { names: names(body.names) } : {}),
    });
  } catch (error) {
    // A step that could never apply was removed: the stack changed.
    if (isDiscarded(error)) emitTableHistoryChanged({ kind: actor.kind, id: actor.id });
    throw error;
  }
  emitStepEffects(outcome.effects);
  // Undo sends `undone` for each occurrence action it took back, redo the
  // action again; by whoever pressed it (a person may step an agent's stack).
  emitOccurrenceEvents(
    await occurrenceEvents(outcome.effects.occurrences, 'history', historyActor())
  );
  emitTableHistoryChanged({ kind: actor.kind, id: actor.id });
  return { step: outcome.step, undo: outcome.undo, redo: outcome.redo };
}
