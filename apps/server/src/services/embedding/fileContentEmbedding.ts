/**
 * fileContentEmbedding — write path + sweep + GC for content-addressed file
 * embeddings (public.file_embeddings).
 *
 * File embeddings are keyed (content_hash, model_id), not per node: any number
 * of file rows (projects linking the same repo, worktrees, nested folders)
 * sharing a body share one chunk set. The dedup check is therefore a pure
 * existence probe by hash — when the hash is already embedded the sweep does
 * no embedding compute and simply relies on the files row as the reference.
 *
 * GC: deleting projects/files drops references only. `gcOrphanFileEmbeddings`
 * reaps chunk sets no file row references; fileIndexing runs it after index
 * purges and reindex sweeps.
 */

import { FileEmbeddings } from '@snaglet/db/tables/files';
import { getDb } from '@snaglet/db';
import { Models } from '@snaglet/db/tables/models';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { generateEmbeddingChunks, type EmbedNodeResult } from './EmbeddingOrchestrator';
import { resolveEmbeddingProvider, type EmbeddingProvider } from './EmbeddingProvider';
import { normalizeEmbeddingContent } from './contentHash';
import { buildEmbeddingTarget } from './EmbeddingNodeClassifier';
import { emitFileEmbeddingCoverageChanged } from '@server/realtime/surfaces/fileEmbeddings';
import { listProjectsWithActiveBackfill } from '@server/services/fileIndexing/projectIndexingStatus';

type ModelRow = NonNullable<Awaited<ReturnType<typeof Models.findByProviderAndModelId>>>;

/**
 * Single-flight: at most one provider call per (modelId, contentHash) in this
 * process. The project backfill, the worker sweep and embedding maintenance
 * all funnel through `embedFileContent`; without this, two of them seeing the
 * same hash "missing" at once both paid for the provider call and raced in
 * replaceChunks. A waiter whose leader succeeded reports
 * `skipped: 'unchanged'` (zero compute). A waiter whose leader FAILED inherits
 * that failure and does not retry: failures are mostly provider-side (rate
 * limit, quota, outage) and an immediate second call doubles cost and can
 * deepen a 429. The content stays a missing candidate, so the next sweep
 * retries it on the normal schedule. The entry is always cleared on settle.
 */
const inFlight = new Map<string, Promise<EmbedNodeResult>>();

/** Test seam: number of in-flight (modelId, contentHash) embeds. */
export function inFlightFileEmbedCount(): number {
  return inFlight.size;
}

export interface EmbedFileContentInput {
  /** Raw-body sha256 — the files.content_hash reference key. */
  contentHash: string;
  /** The file body (normalized before embedding; the hash stays the raw one). */
  content: string | null | undefined;
  /** Explicit provider for sweep/maintenance jobs; normal writes use the active model. */
  providerOverride?: EmbeddingProvider | null;
}

/**
 * Embed one unique file content and persist it keyed (contentHash, modelId).
 * Zero-compute when the pair already exists — returns `skipped: 'unchanged'`
 * without calling the provider, which is the content-addressing payoff.
 */
export async function embedFileContent(input: EmbedFileContentInput): Promise<EmbedNodeResult> {
  const { contentHash, content, providerOverride } = input;
  if (!contentHash) return { ok: false, skipped: 'empty' };

  const prepared = normalizeEmbeddingContent(content);
  if (!prepared) return { ok: false, skipped: 'empty' };

  const provider: EmbeddingProvider | null =
    providerOverride === undefined ? await resolveEmbeddingProvider() : providerOverride;
  if (!provider) {
    return {
      ok: false,
      skipped: 'no-provider',
      error: 'The built-in embedding model is not available.',
    };
  }

  const modelRow = await Models.findByProviderAndModelId(
    provider.info.provider,
    provider.info.model
  );
  if (!modelRow) {
    logger.warn(
      `[fileContentEmbedding] No models row for ${provider.info.provider}:${provider.info.model}. ` +
        `Refusing to write an embedding that would violate file_embeddings_model_id_fkey.`
    );
    return {
      ok: false,
      skipped: 'no-provider',
      model: provider.info.model,
      provider: provider.info.provider,
      error:
        `The built-in embedding model ${provider.info.provider}:${provider.info.model} ` +
        'is missing from the models catalog. Restart Snaglet to restore it.',
    };
  }

  const flightKey = `${modelRow.id}:${contentHash}`;
  const existing = inFlight.get(flightKey);
  if (existing) {
    // Inherit the leader's outcome; a rejection propagates as-is (no retry).
    const leader = await existing;
    if (!leader.ok) return leader;
    return {
      ok: true,
      skipped: 'unchanged',
      model: provider.info.model,
      provider: provider.info.provider,
      contentHash,
    };
  }

  const flight = embedFileContentUnshared(contentHash, prepared, provider, modelRow);
  inFlight.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    if (inFlight.get(flightKey) === flight) inFlight.delete(flightKey);
  }
}

async function embedFileContentUnshared(
  contentHash: string,
  prepared: string,
  provider: EmbeddingProvider,
  modelRow: ModelRow
): Promise<EmbedNodeResult> {
  // Content-addressed dedup: the whole point. Same bytes anywhere in any
  // project → one chunk set per model, zero further compute.
  if (await FileEmbeddings.existsByHashModel(contentHash, modelRow.id)) {
    return {
      ok: true,
      skipped: 'unchanged',
      model: provider.info.model,
      provider: provider.info.provider,
      contentHash,
    };
  }

  const generated = await generateEmbeddingChunks(prepared, provider, modelRow, { contentHash });
  if (!generated.ok) {
    return {
      ok: false,
      skipped: 'provider-error',
      model: provider.info.model,
      provider: provider.info.provider,
      error: generated.error,
    };
  }

  await FileEmbeddings.replaceChunks(contentHash, modelRow.id, generated.chunks);
  emitFileEmbeddingCoverageChanged();

  return {
    ok: true,
    model: provider.info.model,
    provider: provider.info.provider,
    contentHash,
    chunks: generated.chunks.length,
  };
}

/** A changed file is re-embedded only after this long without further changes. */
export const FILE_EMBED_SETTLE_MS = 30_000;
/** ...but a file that never settles (logs, generated output) is embedded at least this often. */
export const FILE_EMBED_MAX_WAIT_MS = 10 * 60_000;
/** Bound on the "recently changed, not yet settled" lookup (it tracks live edits only). */
const UNSETTLED_LOOKUP_LIMIT = 1000;

export interface FileEmbedSettlePolicy {
  settleMs: number;
  maxWaitMs: number;
  /** Injectable clock (tests). */
  now: () => number;
  /** Max rows of the unsettled lookup (tests shrink it to exercise truncation). */
  unsettledLimit: number;
  /** fileId -> when the sweep first saw it waiting for its content to settle. */
  waiting: Map<string, number>;
}

/** Process-wide wait tracker: nodes.updated_at has no "first changed" column, so
 * the max-wait cap is measured from when this process first saw the file
 * waiting (a restart only restarts the cap; it never skips a settle). */
const defaultWaiting = new Map<string, number>();

function resolveSettlePolicy(policy: Partial<FileEmbedSettlePolicy>): FileEmbedSettlePolicy {
  return {
    settleMs: policy.settleMs ?? FILE_EMBED_SETTLE_MS,
    maxWaitMs: policy.maxWaitMs ?? FILE_EMBED_MAX_WAIT_MS,
    now: policy.now ?? Date.now,
    unsettledLimit: policy.unsettledLimit ?? UNSETTLED_LOOKUP_LIMIT,
    waiting: policy.waiting ?? defaultWaiting,
  };
}

/**
 * One representative file node id per content_hash that has NO chunk set under
 * `modelId` yet. DISTINCT ON collapses duplicate references up front, so a
 * batch never wastes slots on copies of the same bytes. Ordered oldest-first
 * so the backlog drains fairly (mirrors the other kinds' sweeps).
 *
 * Settle-before-embed: every save bumps nodes.updated_at, so only files
 * untouched for `settleMs` are returned and ten rapid saves cost one embed. A
 * file still changing after `maxWaitMs` of waiting is returned anyway so it
 * can't starve: overdue files sort first so the batch limit can't cut them
 * off. Their wait entry is cleared by the sweep once the embed was attempted.
 */
export async function listMissingFileEmbeddingCandidates(
  modelId: string,
  limit: number,
  /** Projects whose files must not be picked (a backfill is embedding them). */
  excludeProjectIds: readonly string[] = [],
  settle: Partial<FileEmbedSettlePolicy> = {}
): Promise<string[]> {
  const pool = getDb();
  const policy = resolveSettlePolicy(settle);
  const nowMs = policy.now();
  const cutoff = new Date(nowMs - policy.settleMs);

  // Files changed inside the settle window, oldest change first: track how long
  // each has been waiting and release the ones past the cap.
  const { rows: unsettled } = await pool.query<{ id: string }>(
    `
      SELECT f.id
      FROM public.files f
      JOIN public.nodes n ON n.id = f.id
      JOIN public.containers c ON c.id = f.project_id
      WHERE c.file_indexing_enabled
        AND n.updated_at > $3
        AND NOT (f.project_id = ANY($2::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM public.file_embeddings fe
          WHERE fe.content_hash = f.content_hash AND fe.model_id = $1
        )
      ORDER BY n.updated_at ASC, f.id ASC
      LIMIT $4
    `,
    [modelId, [...excludeProjectIds], cutoff, policy.unsettledLimit]
  );
  const stillWaiting = new Set(unsettled.map((r) => r.id));
  // A truncated sample doesn't list every unsettled file, so absence proves
  // nothing: only prune when the lookup saw them all.
  if (unsettled.length < policy.unsettledLimit) {
    for (const id of policy.waiting.keys()) {
      if (!stillWaiting.has(id)) policy.waiting.delete(id);
    }
  }
  const overdue: string[] = [];
  for (const id of stillWaiting) {
    const since = policy.waiting.get(id);
    if (since === undefined) policy.waiting.set(id, nowMs);
    else if (nowMs - since >= policy.maxWaitMs) overdue.push(id);
  }

  const { rows } = await pool.query<{ id: string }>(
    `
      SELECT id FROM (
        SELECT DISTINCT ON (f.content_hash) f.id, n.updated_at
        FROM public.files f
        JOIN public.nodes n ON n.id = f.id
        JOIN public.containers c ON c.id = f.project_id
        WHERE c.file_indexing_enabled
          AND NOT (f.project_id = ANY($3::text[]))
          AND NOT EXISTS (
            SELECT 1 FROM public.file_embeddings fe
            WHERE fe.content_hash = f.content_hash AND fe.model_id = $1
          )
        ORDER BY f.content_hash, (f.id = ANY($5::text[])) DESC, n.updated_at ASC
      ) candidates
      WHERE updated_at <= $4 OR id = ANY($5::text[])
      ORDER BY (id = ANY($5::text[])) DESC, updated_at ASC
      LIMIT $2
    `,
    [modelId, limit, [...excludeProjectIds], cutoff, overdue]
  );
  return rows.map((r) => r.id);
}

export interface FileEmbedSweepResult {
  /** Contents actually embedded (provider was called). */
  embedded: number;
  /** Contents that already had a chunk set — reference ensured, zero compute. */
  reused: number;
}

/**
 * Sweep pass for the EmbeddingWorker: embed up to `batch` unique file contents
 * that are missing under the provider's model. Bodies are read off disk per
 * candidate (buildEmbeddingTarget), re-hashed, and dedup-checked by hash — a
 * candidate whose on-disk bytes are already embedded costs nothing.
 */
export async function sweepMissingFileEmbeddings(
  batch: number,
  provider: EmbeddingProvider,
  settle: Partial<FileEmbedSettlePolicy> = {}
): Promise<FileEmbedSweepResult> {
  const result: FileEmbedSweepResult = { embedded: 0, reused: 0 };
  const modelRow = await Models.findByProviderAndModelId(
    provider.info.provider,
    provider.info.model
  );
  if (!modelRow) return result;

  // Leave projects with a running backfill to that backfill. Read
  // live on every pass from the in-memory exclusive-op state, so it lifts the
  // moment the backfill ends, fails or is canceled — and after a restart the
  // state is empty, so nothing can stay excluded.
  const candidateIds = await listMissingFileEmbeddingCandidates(
    modelRow.id,
    batch,
    listProjectsWithActiveBackfill(),
    settle
  );
  const waiting = settle.waiting ?? defaultWaiting;
  for (const fileId of candidateIds) {
    try {
      const target = await buildEmbeddingTarget('file', fileId);
      if (!target) {
        waiting.delete(fileId); // missing / oversized / binary — skip, never throw
        continue;
      }
      const embedResult = await embedFileContent({
        contentHash: target.contentHash,
        content: target.content,
        providerOverride: provider,
      });
      // A provider failure keeps an overdue file overdue so the next tick retries.
      if (!embedResult.ok) continue;
      waiting.delete(fileId); // the next version waits afresh
      if (embedResult.skipped === 'unchanged') result.reused += 1;
      else result.embedded += 1;
    } catch (err) {
      waiting.delete(fileId); // don't hot-loop a file that throws
      logger.error(`[fileContentEmbedding] sweep failed for file ${fileId}`, err);
    }
  }
  return result;
}

/**
 * Remove chunk sets whose content_hash no file row references anymore.
 * Opportunistic: runs after index purges (project unlink/demote/gate-off) and
 * at the end of reindex sweeps. Never throws — GC must not fail its caller.
 */
export async function gcOrphanFileEmbeddings(): Promise<number> {
  try {
    const removed = await FileEmbeddings.deleteOrphans();
    if (removed > 0) {
      logger.info(`[fileContentEmbedding] GC removed ${removed} orphaned embedding row(s)`);
    }
    return removed;
  } catch (err) {
    logger.error(`[fileContentEmbedding] GC failed: ${getErrorMessage(err)}`);
    return 0;
  }
}
