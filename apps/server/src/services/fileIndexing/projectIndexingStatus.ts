/**
 * projectIndexingStatus — in-memory runtime state for each project's indexing.
 *
 * Two independent layers, kept separate on purpose:
 *
 *   1. Observational scan markers. Reconcile passes (boot sweep, periodic
 *      safety net, watcher-triggered) report begin/end here so the UI can show
 *      "scanning" and "last checked …". These never block anything.
 *   2. Exclusive maintenance operations — a project-scoped backfill or a
 *      confirmed clear. At most one may hold a project at a time; acquiring is
 *      how the API layer disables conflicting actions server-side, not just in
 *      the UI. Background scans are not excluded by these (a periodic sweep
 *      must never make the user's explicit action fail).
 *
 * State is process-local and resets on restart — honest consequences: the UI
 * shows no "last checked" until the next reconcile completes (boot sweeps run
 * immediately, the periodic net every 5 minutes). Nothing here is durable and
 * nothing here deletes anything.
 */

import type {
  ProjectBackfillProgress,
  ProjectHeldRemovals,
  ProjectIndexingRuntime,
} from '@snaglet/shared/types';
import { emitProjectIndexingStatusChanged } from '@server/realtime/surfaces/fileEmbeddings';
import { isoNow } from '@snaglet/shared/utils';

interface ExclusiveOp {
  kind: 'backfill' | 'clear';
  /** Backfill runs a scan phase then an embed phase; clear has no phases. */
  phase: 'scanning' | 'embedding' | 'clearing';
  progress: ProjectBackfillProgress | null;
}

interface ProjectRuntimeState {
  /** Nesting count of active reconcile scans (sweeps can overlap a manual op). */
  scanDepth: number;
  exclusive: ExclusiveOp | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Non-fatal finding from the last completed reconcile (files kept, not removed). */
  lastWarning: string | null;
  /** Removals the mass-removal backstop is holding; only a person releases them. */
  heldRemovals: ProjectHeldRemovals | null;
  canceled: boolean;
  lastBackfill: ProjectBackfillProgress | null;
}

const states = new Map<string, ProjectRuntimeState>();

/** Throttle progress broadcasts so a large backfill doesn't flood the socket. */
const PROGRESS_EMIT_INTERVAL_MS = 250;
const lastProgressEmitAt = new Map<string, number>();

function stateFor(projectId: string): ProjectRuntimeState {
  let state = states.get(projectId);
  if (!state) {
    state = {
      scanDepth: 0,
      exclusive: null,
      lastCheckedAt: null,
      lastError: null,
      lastWarning: null,
      heldRemovals: null,
      canceled: false,
      lastBackfill: null,
    };
    states.set(projectId, state);
  }
  return state;
}

/** Snapshot the runtime the way the API/UI consume it. */
export function getProjectIndexingRuntime(projectId: string): ProjectIndexingRuntime {
  const s = states.get(projectId);
  if (!s) {
    return {
      op: 'idle',
      activeExclusiveOp: null,
      backfill: null,
      lastCheckedAt: null,
      lastError: null,
      lastWarning: null,
      heldRemovals: null,
    };
  }
  const op = s.exclusive
    ? s.exclusive.phase === 'clearing'
      ? 'clearing'
      : s.exclusive.phase
    : s.scanDepth > 0
      ? 'scanning'
      : s.canceled
        ? 'cancelled'
        : 'idle';
  return {
    op,
    activeExclusiveOp: s.exclusive?.kind ?? null,
    backfill: s.exclusive?.kind === 'backfill' ? s.exclusive.progress : s.lastBackfill,
    lastCheckedAt: s.lastCheckedAt,
    lastError: s.lastError,
    lastWarning: s.lastWarning,
    heldRemovals: s.heldRemovals ? { ...s.heldRemovals } : null,
  };
}

function broadcast(projectId: string): void {
  lastProgressEmitAt.set(projectId, Date.now());
  emitProjectIndexingStatusChanged(projectId, getProjectIndexingRuntime(projectId));
}

/* Observational scan markers (reconcile passes) */

export function beginProjectScan(projectId: string): void {
  const s = stateFor(projectId);
  s.scanDepth += 1;
  if (s.scanDepth === 1 && !s.exclusive) broadcast(projectId);
}

/** End a scan. A completed scan stamps `lastCheckedAt`; a failed one records
 * the error so the UI can show a `failed` state instead of a stale "complete".
 * `warning` (completed scans only) records files the scan kept rather than
 * removed — unreadable folders, a held-back mass removal — so they are never
 * silently left unindexed; the next clean scan clears it. `held` is the
 * mass-removal hold this scan found (null = none, which clears an old hold). */
export function endProjectScan(
  projectId: string,
  error?: string,
  completed = true,
  warning?: string,
  held?: { count: number; total: number } | null
): void {
  const s = stateFor(projectId);
  s.scanDepth = Math.max(0, s.scanDepth - 1);
  if (error !== undefined) {
    s.lastError = error;
  } else if (completed) {
    s.lastCheckedAt = isoNow();
    s.lastError = null;
    s.lastWarning = warning ?? null;
    setHeld(s, held ?? null);
  }
  if (!s.exclusive) broadcast(projectId);
}

/**
 * Record a non-fatal indexing finding outside a reconcile pass (the live
 * watcher holding back removals, or pausing because its root vanished). The
 * next clean reconcile clears it.
 */
export function recordProjectIndexingWarning(
  projectId: string,
  warning: string,
  held?: { count: number; total: number }
): void {
  const s = stateFor(projectId);
  s.lastWarning = warning;
  if (held) setHeld(s, held);
  if (!s.exclusive) broadcast(projectId);
}

/** Record (or clear) a hold, keeping `since` while the hold persists. */
function setHeld(s: ProjectRuntimeState, held: { count: number; total: number } | null): void {
  if (!held) {
    s.heldRemovals = null;
    return;
  }
  s.heldRemovals = {
    count: held.count,
    total: held.total,
    since: s.heldRemovals?.since ?? isoNow(),
  };
}

/* Exclusive maintenance operations (backfill / clear) */

/**
 * Acquire the project's exclusive maintenance slot. Returns false when a
 * backfill or clear is already running — the caller should surface a 409
 * rather than queueing destructive/expensive work invisibly.
 */
export function tryBeginExclusiveOp(projectId: string, kind: 'backfill' | 'clear'): boolean {
  const s = stateFor(projectId);
  if (s.exclusive) return false;
  s.canceled = false;
  s.lastError = null;
  s.lastBackfill = null;
  s.exclusive = {
    kind,
    phase: kind === 'clear' ? 'clearing' : 'scanning',
    progress: null,
  };
  broadcast(projectId);
  return true;
}

/** Move an active backfill from its reconcile phase into the embed phase. */
export function markBackfillEmbedding(projectId: string, progress: ProjectBackfillProgress): void {
  const s = stateFor(projectId);
  if (s.exclusive?.kind !== 'backfill') return;
  s.exclusive.phase = 'embedding';
  s.exclusive.progress = progress;
  broadcast(projectId);
}

/** Update backfill progress (throttled broadcast; `force` for terminal ticks). */
export function updateBackfillProgress(
  projectId: string,
  progress: ProjectBackfillProgress,
  force = false
): void {
  const s = stateFor(projectId);
  if (s.exclusive?.kind !== 'backfill') return;
  s.exclusive.progress = progress;
  const last = lastProgressEmitAt.get(projectId) ?? 0;
  if (force || Date.now() - last >= PROGRESS_EMIT_INTERVAL_MS) broadcast(projectId);
}

/**
 * Projects currently holding a `backfill` exclusive op. Read live (never
 * cached) by the embedding sweep so it skips files a backfill is about to
 * embed; the set empties as soon as `endExclusiveOp` runs (success, failure or
 * cancel), and is empty after a restart since this state is in-memory.
 */
export function listProjectsWithActiveBackfill(): string[] {
  const ids: string[] = [];
  for (const [projectId, s] of states) {
    if (s.exclusive?.kind === 'backfill') ids.push(projectId);
  }
  return ids;
}

/** Release the exclusive slot. `error` marks the operation as failed. */
export function endExclusiveOp(projectId: string, error?: string, canceled = false): void {
  const s = stateFor(projectId);
  if (s.exclusive?.kind === 'backfill') s.lastBackfill = s.exclusive.progress;
  s.canceled = canceled;
  s.exclusive = null;
  s.lastError = error ?? null;
  broadcast(projectId);
}
