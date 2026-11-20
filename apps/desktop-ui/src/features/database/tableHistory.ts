/**
 * The user's table undo history, shared by every table pane: which step
 * Undo and Redo would take next, and running them.
 *
 * The server keeps one linear stack per actor (see docs/architecture.md). This module reads the caller's own stack once for all
 * subscribers and re-reads it whenever the server says that stack changed
 * (`table.history.changed`) or the connection was restored. Undo and redo
 * run one at a time, in order, so pressing Cmd+Z three times steps back
 * three times. A refused step (409) changes nothing: it is reported in a
 * toast and the stack is read again. What a step changed reaches the panes
 * as the server's usual table events.
 */

import { useSyncExternalStore } from 'react';
import type {
  TableHistoryActorKind,
  TableHistoryConflictDetails,
  TableHistoryStep,
  TableHistoryStepKind,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { FetchError, tablesApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { subscribeTableEvents } from './tableEvents';

export type TableHistoryDirection = 'undo' | 'redo';

export interface TableHistorySnapshot {
  /** The step Undo would revert next, or null. */
  undo: TableHistoryStep | null;
  /** The step Redo would re-apply next, or null. */
  redo: TableHistoryStep | null;
  /** An undo or redo is running or queued. */
  busy: boolean;
}

export type TableHistoryPrepared = 'ready' | 'saved' | 'blocked';

export interface TableHistoryStepOptions {
  /**
   * The step the control showed. The server refuses (stale) when it is no
   * longer the next one, so a stale button never reverts something else.
   * Without it, the stack is read first and its current next step runs.
   */
  expected?: TableHistoryStep | null;
  /**
   * Runs first, e.g. saving the pane's open row: `blocked` cancels the step,
   * and `saved` makes it take the stack's current next step instead of
   * `expected`, since the save may have just become that step.
   */
  prepare?: () => Promise<TableHistoryPrepared>;
  /** The table the pane shows: a step elsewhere gets a toast naming it. */
  tableId?: string;
  /**
   * Reject with the refusal's sentence instead of showing it in a toast, for
   * a caller that runs several steps as one and must stop at the first one
   * refused (the calendar's multi-step undo).
   */
  rethrow?: boolean;
}

const EMPTY: TableHistorySnapshot = { undo: null, redo: null, busy: false };
let snapshot: TableHistorySnapshot = EMPTY;
let actor: { kind: TableHistoryActorKind; id: string } | null = null;
const listeners = new Set<() => void>();
let stopEvents: (() => void) | undefined;
/** Newest read started; an older read's answer is dropped. */
let readGeneration = 0;
let pending = 0;
let queue: Promise<void> = Promise.resolve();

function publish(next: Partial<TableHistorySnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

/** Read the caller's stack again; failures keep the last known steps. */
async function refreshTableHistory(): Promise<void> {
  const generation = ++readGeneration;
  try {
    const history = await tablesApi.history(1);
    if (generation !== readGeneration) return;
    if (history.actor) actor = { kind: history.actor.kind, id: history.actor.id };
    publish({ undo: history.undo, redo: history.redo });
  } catch (error: unknown) {
    if (generation === readGeneration)
      console.error('[tableHistory] reading the undo history failed', getErrorMessage(error));
  }
}

function listen(): void {
  if (stopEvents) return;
  stopEvents = subscribeTableEvents((event) => {
    if (event.type === 'tables.invalidated') void refreshTableHistory();
    if (event.type !== 'table.history.changed') return;
    // Until the first read names our stack, any change may be ours.
    if (!actor || (event.stack.kind === actor.kind && event.stack.id === actor.id))
      void refreshTableHistory();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    listen();
    void refreshTableHistory();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    stopEvents?.();
    stopEvents = undefined;
  };
}

function getSnapshot(): TableHistorySnapshot {
  return snapshot;
}

const idle = () => () => {};

/** The caller's next undo and redo steps, kept current while `enabled`. */
export function useTableHistory(enabled = true): TableHistorySnapshot {
  return useSyncExternalStore(enabled ? subscribe : idle, enabled ? getSnapshot : getEmpty);
}

function getEmpty(): TableHistorySnapshot {
  return EMPTY;
}

function conflictDetails(details: unknown): TableHistoryConflictDetails | null {
  if (typeof details !== 'object' || details === null || !('reason' in details)) return null;
  return details as TableHistoryConflictDetails;
}

/** Why a step was refused, for a toast. */
export function tableHistoryErrorMessage(
  direction: TableHistoryDirection,
  step: TableHistoryStep | null,
  error: unknown
): string {
  const what = step ? ` “${step.label}”` : '';
  const done = direction === 'undo' ? 'undone' : 'redone';
  if (error instanceof FetchError && error.status === 409) {
    const details = conflictDetails(error.details);
    switch (details?.reason) {
      case 'stale':
        return `Your table history changed, so nothing was ${done}. Try again.`;
      case 'empty':
        return `Nothing to ${direction}.`;
      case 'discarded':
        // The server removed a step that could never apply; it says why.
        return error.message;
      case 'nameTaken': {
        const taken = details.names?.[0];
        return taken
          ? `Can't ${direction}${what}: the name “${taken.name}” is used by another ${taken.kind} now. Rename that one and try again.`
          : `Can't ${direction}${what}: a name it needs is taken now.`;
      }
      default:
        // Named conflicts: something the step touches changed since. Without
        // any, the server's message says why (busy tables, say).
        return details?.conflicts?.length
          ? `Can't ${direction}${what}: the data changed since, so nothing was ${done}. ${error.message}`
          : `Can't ${direction}${what}: ${error.message}`;
    }
  }
  return `Can't ${direction}${what}: ${getErrorMessage(error, 'the request failed')}`;
}

async function runStep(
  direction: TableHistoryDirection,
  options: TableHistoryStepOptions
): Promise<void> {
  const prepared = options.prepare ? await options.prepare() : 'ready';
  if (prepared === 'blocked') return;
  const expected = prepared === 'saved' ? undefined : options.expected;
  if (expected === undefined) await refreshTableHistory();
  const target = expected === undefined ? snapshot[direction] : expected;
  if (!target) return;
  try {
    const result = await tablesApi.stepHistory(direction, { stepId: target.id });
    readGeneration++;
    publish({ undo: result.undo, redo: result.redo });
    if (options.tableId && !result.step.tableIds.includes(options.tableId))
      showToast(`${direction === 'undo' ? 'Undone' : 'Redone'}: ${result.step.label}`);
  } catch (error: unknown) {
    const message = tableHistoryErrorMessage(direction, target, error);
    if (!options.rethrow) showToast(message, { durationMs: 6000 });
    // Nothing changed on a refusal; show the stack as it is now.
    await refreshTableHistory();
    if (options.rethrow) throw new Error(message);
  }
}

/**
 * Undo or redo the caller's next table step, after any step already
 * running. Resolves once this one has finished (or was refused; with
 * `rethrow`, a refusal rejects instead).
 */
export function stepTableHistory(
  direction: TableHistoryDirection,
  options: TableHistoryStepOptions = {}
): Promise<void> {
  pending++;
  publish({ busy: true });
  const step = queue.then(() => runStep(direction, options));
  queue = step
    .catch((error: unknown) => {
      if (!options.rethrow)
        showToast(tableHistoryErrorMessage(direction, null, error), { durationMs: 6000 });
    })
    .finally(() => {
      pending--;
      if (!pending) publish({ busy: false });
    });
  // The queue itself never rejects, so later steps still run after a refusal.
  return options.rethrow ? queue.then(() => step) : queue;
}

/**
 * The caller's newest step, read right after their own write made it: null
 * unless it is a done step in `tableId` (of `kind`, when given), or when the
 * history can't be read, so an Undo offered for that write never reverses
 * something else.
 */
export async function newestTableStep(
  tableId: string,
  kind?: TableHistoryStepKind
): Promise<TableHistoryStep | null> {
  try {
    const step = (await tablesApi.history(1)).undo;
    return step &&
      step.state === 'done' &&
      step.tableIds.includes(tableId) &&
      (!kind || step.kind === kind)
      ? step
      : null;
  } catch {
    return null;
  }
}

/** @public Test isolation for the module-level stack. */
export function __resetTableHistoryForTests(): void {
  snapshot = EMPTY;
  actor = null;
  listeners.clear();
  stopEvents?.();
  stopEvents = undefined;
  readGeneration = 0;
  pending = 0;
  queue = Promise.resolve();
}
