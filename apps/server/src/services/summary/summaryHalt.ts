/**
 * summaryHalt — a broken compaction path stops the thread; it never falls back
 * to another model. An owed summary pass that cannot run aborts the in-flight
 * run, raises a notification, writes a chat line naming the model and reason,
 * and blocks new sends until a working summary model is set. Two shapes:
 * `not-configured` (no model resolved) and `model-failing` (generation threw).
 * Unblock is lazy: the next send re-runs the resolver, and a `model-failing`
 * halt lifts only for a different model. State is in-process: a restart clears
 * it and the next owed pass re-raises it.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import type { GenerateSummaryOutcome } from '@server/services/SummaryService';
import { logger } from '@server/config/logger';
import { notificationService } from '@server/services/NotificationService';
import { isHelperThread } from '@server/services/subagents/helperVisibility';
import { abortThread } from '@server/services/SocketService/abortStore';
import {
  emitSummaryModelRestoredEvent,
  emitSummaryModelUnavailableEvent,
} from '@server/services/SocketService/threadEvents';
import { resolveUtilityModel } from './UtilityModelResolver';

/**
 * Which failure shape halted the thread.
 *  - `not-configured` — resolution never produced a model.
 *  - `model-failing`  — a model resolved and then failed at call time.
 */
type SummaryHaltKind = 'not-configured' | 'model-failing';

export interface SummaryHalt {
  threadId: string;
  /** Whose summary pass failed; null for an agent-less (shared) pass. */
  agentId: string | null;
  kind: SummaryHaltKind;
  /** The model that failed. Always set for 'model-failing', null otherwise. */
  providerId: string | null;
  modelId: string | null;
  /** Enumerated skip reason from the summary pass. */
  reason: string;
  /** Provider/resolver text — the 404 body, the missing credential, etc. */
  detail: string | null;
  raisedAt: string;
}

export interface RaiseSummaryHaltInput {
  threadId: string;
  agentId?: string | null;
  agentName?: string | null;
  kind: SummaryHaltKind;
  reason: string;
  detail?: string | null;
  providerId?: string | null;
  modelId?: string | null;
}

/**
 * Skip reasons that mean the compaction path is broken, mapped to the shape
 * the user is shown. Everything absent is a normal cadence or policy outcome
 * (not-due, in-flight, daily-cap-reached, compaction disabled, quality-floor)
 * and must never halt a thread.
 */
const HALT_REASONS: Readonly<Record<string, SummaryHaltKind>> = {
  'no-model-for-agent': 'not-configured',
  'unsupported-provider': 'not-configured',
  'no-credentials': 'not-configured',
  'no-summary-model-configured': 'not-configured',
  'resolution-failed': 'not-configured',
  'generation-failed': 'model-failing',
};

/**
 * Raise a halt when this summary outcome means the thread cannot compact.
 * Returns the halt, or null when the outcome was benign.
 *
 * The single entry point for run-attached callers, so "which skips are fatal"
 * is decided in one table instead of at each call site.
 */
export async function haltOnSummaryFailure(
  outcome: GenerateSummaryOutcome,
  context: { threadId: string; agentId?: string | null; agentName?: string | null }
): Promise<SummaryHalt | null> {
  if (outcome.status !== 'skipped') return null;
  // A lookup that could not complete (database unreachable) says nothing
  // about the configured model; the next pass retries.
  if (outcome.retryable) {
    logger.warn(
      `[summary-halt] thread ${context.threadId}: summary skipped, will retry — ` +
        `${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`
    );
    return null;
  }
  const kind = HALT_REASONS[outcome.reason];
  if (!kind) return null;
  // A subagent helper's thread is hidden: a halt there would stop it with no
  // one able to see why. It carries on with its replay digest instead.
  if (await isHelperThread(context.threadId)) {
    logger.warn(
      `[summary-halt] helper thread ${context.threadId}: summary unavailable, not halting — ` +
        `${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`
    );
    return null;
  }
  return raiseSummaryHalt({
    threadId: context.threadId,
    agentId: context.agentId ?? null,
    agentName: context.agentName ?? null,
    kind,
    reason: outcome.reason,
    detail: outcome.detail ?? null,
    providerId: outcome.providerId ?? null,
    modelId: outcome.modelId ?? null,
  });
}

const halts = new Map<string, SummaryHalt>();

export function getSummaryHalt(threadId: string): SummaryHalt | null {
  return halts.get(threadId) ?? null;
}

export function isThreadSummaryHalted(threadId: string): boolean {
  return halts.has(threadId);
}

/** Drop the halt without narrating. Used by the resolver-verified unblock. */
function forgetSummaryHalt(threadId: string): void {
  halts.delete(threadId);
}

/** Test-only. */
export function resetSummaryHaltsForTests(): void {
  halts.clear();
}

function modelLabel(halt: SummaryHalt): string {
  return halt.providerId && halt.modelId ? `${halt.providerId}/${halt.modelId}` : 'none';
}

/**
 * The refusal a blocked thread returns to a sender. Distinct per shape, and
 * always actionable — the composer shows this verbatim.
 */
export function summaryHaltRefusal(halt: SummaryHalt): string {
  if (halt.kind === 'model-failing') {
    return (
      `This thread is blocked: its summary model ${modelLabel(halt)} is failing` +
      (halt.detail ? ` (${halt.detail})` : '') +
      '. Point the summary model at a working one to continue — no fallback model will be chosen for you.'
    );
  }
  if (halt.reason === 'no-credentials') {
    return (
      "This thread is blocked: the summary model's credential is unavailable" +
      (halt.detail ? ` (${halt.detail})` : '') +
      '. Reconnect it on the Providers page or pick another credential to continue — no ' +
      'other credential will be chosen for you.'
    );
  }
  return (
    'This thread is blocked: no summary model is available' +
    (halt.detail ? ` (${halt.detail})` : '') +
    '. Set a summary model for this agent to continue — no fallback model will be chosen for you.'
  );
}

function haltTitle(halt: SummaryHalt): string {
  if (halt.kind === 'model-failing')
    return `Summary model ${modelLabel(halt)} failed — run stopped`;
  if (halt.reason === 'no-credentials') return 'Summary model credential missing — run stopped';
  return 'No summary model — run stopped';
}

/**
 * Stop the thread because a summary that was owed could not be written.
 * Idempotent per (thread, kind, model); a different failure replaces the
 * record and re-narrates so the copy names the right model. Aborts first and
 * narrates last, so the chat line replays after whatever the dying run
 * persisted. Never throws: a narration failure still leaves the halt in place.
 */
export async function raiseSummaryHalt(input: RaiseSummaryHaltInput): Promise<SummaryHalt> {
  const halt: SummaryHalt = {
    threadId: input.threadId,
    agentId: input.agentId ?? null,
    kind: input.kind,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    reason: input.reason,
    detail: input.detail ?? null,
    raisedAt: new Date().toISOString(),
  };

  const previous = halts.get(input.threadId);
  const isRepeat =
    previous !== undefined &&
    previous.kind === halt.kind &&
    previous.providerId === halt.providerId &&
    previous.modelId === halt.modelId;

  halts.set(input.threadId, halt);
  if (isRepeat) return halt;

  logger.error(
    `[summary-halt] thread ${input.threadId} stopped — ${halt.kind}: ${halt.reason}` +
      (halt.detail ? ` (${halt.detail})` : '') +
      (halt.modelId ? ` [${modelLabel(halt)}]` : '')
  );

  const aborted = abortThread(input.threadId);
  if (aborted > 0) {
    logger.warn(
      `[summary-halt] aborted ${aborted} in-flight session(s) on thread ${input.threadId}`
    );
  }

  // `run_failed` because the run was stopped; it carries threadId, so clicking
  // the notification opens the thread that needs the fix.
  try {
    await notificationService.create({
      type: 'run_failed',
      title: haltTitle(halt),
      body: summaryHaltRefusal(halt),
      threadId: input.threadId,
      agentId: halt.agentId,
    });
  } catch (err) {
    logger.error(`[summary-halt] notification failed: ${getErrorMessage(err)}`);
  }

  await emitSummaryModelUnavailableEvent(input.threadId, {
    kind: halt.kind,
    model:
      halt.providerId && halt.modelId
        ? { providerId: halt.providerId, modelId: halt.modelId }
        : null,
    reason: halt.detail ?? halt.reason,
    cause: halt.reason,
    agentName: input.agentName ?? null,
  }).catch((err) => logger.error(`[summary-halt] halt narration failed: ${getErrorMessage(err)}`));

  return halt;
}

/**
 * Re-check a halted thread and lift the block when a working summary model is
 * set. Called lazily on the next send/dispatch. Returns true when the thread
 * may proceed. A `model-failing` halt stands while the resolver returns the
 * same model that failed; any other resolution clears it.
 */
export async function clearSummaryHaltIfRepaired(threadId: string): Promise<boolean> {
  const halt = halts.get(threadId);
  if (!halt) return true;

  const resolution = await resolveUtilityModel({
    purpose: 'thread-summary',
    threadId,
    agentId: halt.agentId ?? undefined,
  });
  if (!resolution.ok) return false;

  const { providerId, modelId } = resolution.model;
  if (halt.kind === 'model-failing' && providerId === halt.providerId && modelId === halt.modelId) {
    return false;
  }

  forgetSummaryHalt(threadId);
  logger.info(
    `[summary-halt] thread ${threadId} unblocked — summary model ${providerId}/${modelId}`
  );
  await emitSummaryModelRestoredEvent(threadId, { providerId, modelId }).catch((err) =>
    logger.warn(`[summary-halt] restore narration failed: ${getErrorMessage(err)}`)
  );
  return true;
}
