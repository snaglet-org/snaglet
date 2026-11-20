/**
 * Project file-indexing status + embeddings maintenance contract.
 *
 * The core product rule these types encode: PAUSING background indexing and
 * DELETING stored embeddings are different actions with different shapes.
 * Pausing is a reversible preference (`workerEnabled`); deletion is an
 * explicit, quantified, confirmed operation (`ProjectEmbeddingsClearPreview`
 * → confirmed clear). Nothing in the pause path carries deletion semantics.
 */

/**
 * Provenance of `<folder>/snaglet.config.json` — deliberately more granular than a
 * boolean so the lifecycle can distinguish "user paused indexing" (config
 * present, `enabled: false` → preserve data) from "config removed from the
 * folder" (missing → the intentionally destructive unconfigure path) from
 * "config broken or unreachable" (invalid/unreadable → fail safe: stop
 * indexing, never destroy data over ambiguity).
 */
export type ProjectIndexConfigStatus = 'present' | 'missing' | 'invalid' | 'unreadable';

/** What the indexing runtime is doing for a project right now. */
export type ProjectIndexingOp = 'idle' | 'scanning' | 'embedding' | 'clearing' | 'cancelled';

/** Progress of an active project-scoped backfill pass. */
export interface ProjectBackfillProgress {
  /** Unique missing/stale contents the pass set out to embed. */
  total: number;
  /** Candidates handled so far (embedded + reused + failed + skipped). */
  processed: number;
  /** Contents actually embedded (provider was called). */
  embedded: number;
  /** Contents that already had a chunk set — reference ensured, zero compute. */
  reused: number;
  /** Candidates that errored; the pass continues past them. */
  failed: number;
}

/**
 * Live runtime state for one project's indexing, as broadcast over the
 * workspace event channel and embedded in the status payload.
 */
export interface ProjectIndexingRuntime {
  op: ProjectIndexingOp;
  /** The exclusive maintenance operation holding the project, if any. */
  activeExclusiveOp: 'backfill' | 'clear' | null;
  /** Progress of the active or most recently finished backfill. */
  backfill: ProjectBackfillProgress | null;
  /** ISO time the last disk↔DB reconcile completed (any trigger). */
  lastCheckedAt: string | null;
  /** Set when the most recent operation failed; cleared by the next success. */
  lastError: string | null;
  /**
   * Non-fatal finding from the last completed reconcile: files it KEPT instead
   * of removing (folders it could not read, or a mass removal held back).
   * Cleared by the next clean reconcile. Optional for older payloads.
   */
  lastWarning?: string | null;
  /**
   * Removals the mass-removal backstop is HOLDING (rows kept although their
   * files are missing). Only a person can release them, through the confirmed
   * apply-held-removals action; nothing releases them automatically. Cleared by
   * the next clean reconcile. Optional for older payloads.
   */
  heldRemovals?: ProjectHeldRemovals | null;
}

/** A batch of removals held back by the mass-removal backstop. */
export interface ProjectHeldRemovals {
  /** Indexed files that are missing from the folder and were kept. */
  count: number;
  /** Indexed files the project had when the hold was recorded. */
  total: number;
  /** ISO time the hold was first recorded (kept while it persists). */
  since: string;
}

/** POST /api/projects/:id/indexing/apply-held-removals body. */
export interface ProjectApplyHeldRemovalsRequest {
  /** The held count the person saw and confirmed (`heldRemovals.count`). */
  expected: number;
}

/** POST /api/projects/:id/indexing/apply-held-removals result. */
export interface ProjectApplyHeldRemovalsResult {
  removed: number;
  kept: number;
  upserted: number;
}

/** Coverage counts under the active embedding model. */
export interface ProjectIndexingCoverage {
  embeddedFiles: number;
  totalFiles: number;
}

/** GET /api/projects/:id/indexing-status */
export interface ProjectIndexingStatus extends ProjectIndexingRuntime {
  hasFolder: boolean;
  folderPath: string | null;
  configStatus: ProjectIndexConfigStatus;
  /**
   * The effective worker preference: true only when both the DB mirror and the
   * on-disk `embeddings.enabled` agree the background worker should run.
   * False means PAUSED — existing indexed rows and embeddings are preserved.
   */
  workerEnabled: boolean;
  coverage: ProjectIndexingCoverage;
  /**
   * The project whose index actually holds this folder's file rows. Differs
   * from the requested project when the folder is nested inside (or equal to)
   * another indexing project's tree ("satellite" projects share the owner's
   * index). Null when no ownership mapping is known (e.g. paused).
   */
  ownerProjectId: string | null;
}

/**
 * GET /api/projects/:id/embeddings/clear-preview — the honest numbers behind
 * the destructive confirmation.
 *
 * File embeddings are content-addressed and may be shared by several projects.
 * `reclaimableBytes` therefore counts only chunk rows whose content would
 * become genuinely orphaned when this project's file rows are deleted;
 * `linkedBytes` is everything the project references. The two differ whenever
 * `sharedContents > 0`, and the UI must never present `linkedBytes` as freed
 * space.
 */
export interface ProjectEmbeddingsClearPreview {
  /** Indexed file rows this project owns (what the clear deletes). */
  fileCount: number;
  /** Distinct embedded contents this project's files reference. */
  uniqueContents: number;
  /** Contents also referenced by at least one other project (kept on clear). */
  sharedContents: number;
  /** Contents referenced only by this project (orphaned + GC'd on clear). */
  exclusiveContents: number;
  /** Embedding chunk rows linked to this project's contents (all models). */
  vectorChunks: number;
  /** Stored bytes of every linked chunk row (heap tuple size). */
  linkedBytes: number;
  /** Stored bytes that genuinely become orphaned and are removed by the clear. */
  reclaimableBytes: number;
}

/** POST /api/projects/:id/embeddings/clear result. */
export interface ProjectEmbeddingsClearResult {
  removedFiles: number;
  removedChunks: number;
}

/** POST /api/projects/:id/embeddings/backfill result (the pass runs async). */
export interface ProjectBackfillStartResult {
  started: boolean;
}

/** Terminal counts of one completed backfill pass. */
export interface ProjectBackfillResult extends ProjectBackfillProgress {
  canceled?: boolean;
  /** File rows reconciled from disk before embedding (upserted + removed). */
  reconciledUpserts: number;
  reconciledRemovals: number;
}
