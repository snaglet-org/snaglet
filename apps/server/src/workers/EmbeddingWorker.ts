/**
 * EmbeddingWorker — periodic re-embed sweep.
 *
 * Every minute, for each embeddable kind, embed a batch of nodes that are
 * missing an embedding or stale (their content's `nodes.updated_at` is newer
 * than their embedding's `updated_at`). Discrete writes embed inline elsewhere;
 * this sweep is the universal backstop and the path that re-embeds human
 * doc-body autosaves (which intentionally don't embed inline).
 *
 * `embedNode` content-hash-dedups, so a re-check of unchanged content is
 * cheap and touches the embedding's `updated_at` to converge (stops re-flagging
 * a node whose content didn't actually change).
 *
 * Runtime throttle: every tick re-reads the worker policy (see
 * services/workers/workerPolicy.ts) rather than latching one at boot, so a user
 * pausing from Settings → Background work takes effect within a tick and
 * resuming needs no restart. `paused` keeps the timer alive and does nothing;
 * `off` disarms the timer entirely (a settings change re-arms it); `immediate`
 * shortens the cadence and grows the batch. `RUN_BACKGROUND_WORKERS=false`
 * still overrides all of it.
 */

import { getDb } from '@snaglet/db';
import { Models } from '@snaglet/db/tables/models';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { embedNode } from '@server/services/embedding/EmbeddingOrchestrator';
import {
  resolveEmbeddingProvider,
  MockEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { getLocalEmbedderStatus } from '@server/services/embedding/LocalEmbedderService';
import { embeddingSettings } from '@server/services/embedding/EmbeddingSettings';
import { reseedEmbedderIfMissing } from '@server/services/embedding/EmbeddingBootstrap';
import { LOCAL_EMBEDDER_PROVIDER_ID } from '@server/services/embedding/embedderModelManifest';
import {
  buildToolFsEntryMap,
  composeToolEmbeddingText,
  type FsEntry,
  type ToolDbRow,
} from '@server/services/embedding/toolEmbeddingComposer';
import { logger } from '@server/config/logger';
import { rethrowIfProgrammerError } from '@server/utils/sqlErrors';
import { elapsedMs } from '@snaglet/shared/utils';
import { sweepSettledDocReembeds } from '@server/services/embedding/docSettleReembed';
import {
  buildEmbeddingTarget,
  classifyEmbeddingTarget,
  type EmbeddingNodeType,
} from '@server/services/embedding/EmbeddingNodeClassifier';
import { sweepMissingFileEmbeddings } from '@server/services/embedding/fileContentEmbedding';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { ResolvedWorkerPolicy, WorkerQueueDepth } from '@snaglet/shared/types';
import { onWorkerPolicyChange, resolveWorkerPolicy } from '@server/services/workers/workerPolicy';
import { beginSweep, endSweep, registerWorker } from '@server/services/workers/workerStatus';
import { sweepTableEntries } from '@server/services/tableSemantic/TableSemanticService';
import { runEmbeddingWorkerLanes } from './runEmbeddingWorkerLanes';
import { EMBEDDABLE_MESSAGE_SQL } from '@server/services/embedding/messageEligibility';

/** Status/telemetry id for this worker. */
export const EMBEDDING_WORKER_ID = 'embedding';

/** Node kinds the worker sweeps for missing/stale embeddings. */
type EmbeddableKind =
  | 'message'
  | 'memory'
  | 'thread_summary'
  | 'doc'
  | 'container'
  | 'file'
  | 'image'
  | 'tool';

const PERIODIC_NODES: EmbeddableKind[] = [
  'message',
  'memory',
  'thread_summary',
  'doc',
  'container',
  'file',
  'image',
  'tool',
];

// The tool FS map is stable for the life of the process (tool folders only
// change with a deploy). Lazy-built once on first use so import-time doesn't
// touch the filesystem (keeps tests fast).
let toolFsMap: Map<string, FsEntry> | null = null;
function getToolFsMap(): Map<string, FsEntry> {
  if (toolFsMap === null) toolFsMap = buildToolFsEntryMap();
  return toolFsMap;
}

let timer: NodeJS.Timeout | null = null;
/** Interval (ms) the live timer is currently armed at — 0 when disarmed. */
let armedTickMs = 0;
/** True between startEmbeddingWorker() and stopEmbeddingWorker(). */
let desired = false;
/** Unsubscribe for the settings listener that re-arms after a mode change. */
let policyUnsubscribe: (() => void) | null = null;
let running = false;
// Tracks the in-flight tick so stopEmbeddingWorker can await it instead of
// leaving it to drain in the background after shutdown has moved on (it was
// racing DB pool teardown and logging "Chunked long content" etc. well after
// the rest of gracefulShutdown had finished).
let currentTick: Promise<void> | null = null;
const lastPeriodicRun = new Map<EmbeddableKind, number>();

interface NodeStaleQuery {
  /** SELECT id, content for nodes missing an up-to-date embedding. */
  sql: string;
  /** Map a row to the orchestrator input. */
  toInput: (row: { id: string; content: string }) => Parameters<typeof embedNode>[0];
}

// A node is a re-embed candidate when it has NO embedding newer than its
// content's `nodes.updated_at` — i.e. missing entirely, or edited since it was
// last embedded. `embedNode` then dedups by content hash (and touches the
// row's updated_at on no-op so this converges). 'tool' has its own composed
// path (see processStaleTool); 'file' is content-addressed and swept by
// sweepMissingFileEmbeddings (see processStaleFile).
const STALE_QUERIES: Record<Exclude<EmbeddableKind, 'tool' | 'file'>, NodeStaleQuery> = {
  container: {
    sql: `
      SELECT c.id::text AS id, c.name AS content
      FROM containers c
      JOIN public.nodes n ON n.id = c.id
      WHERE c.name IS NOT NULL AND LENGTH(TRIM(c.name)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.embeddings e
          WHERE e.node_id = c.id::text AND e.model_id = $1 AND e.updated_at >= n.updated_at
        )
      ORDER BY n.updated_at ASC
      LIMIT $2
    `,
    toInput: (row) => ({ nodeId: row.id, content: row.content }),
  },
  image: {
    // Pixels aren't embedded — an image is searchable via its agent-authored
    // description + tags, built by buildEmbeddingTarget() per candidate. Like
    // `file`, the empty content here is a placeholder; this query is just the
    // staleness gate: images with searchable text and no up-to-date embedding.
    sql: `
      SELECT i.id::text AS id, '' AS content
      FROM images i
      JOIN public.nodes n ON n.id = i.id
      WHERE ((i.description IS NOT NULL AND LENGTH(TRIM(i.description)) > 0)
          OR COALESCE(array_length(i.tags, 1), 0) > 0)
        AND NOT EXISTS (
          SELECT 1 FROM public.embeddings e
          WHERE e.node_id = i.id::text AND e.model_id = $1 AND e.updated_at >= n.updated_at
        )
      ORDER BY n.updated_at ASC
      LIMIT $2
    `,
    toInput: (row) => ({ nodeId: row.id, content: row.content }),
  },
  message: {
    // Keep periodic selection aligned with direct writes and backfills.
    sql: `
      SELECT m.id::text AS id, m.content
      FROM messages m
      JOIN public.nodes n ON n.id = m.id
      WHERE m.content IS NOT NULL
        AND LENGTH(TRIM(m.content)) > 0
        AND ${EMBEDDABLE_MESSAGE_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM public.embeddings e
          WHERE e.node_id = m.id::text AND e.model_id = $1 AND e.updated_at >= n.updated_at
        )
      ORDER BY n.updated_at ASC
      LIMIT $2
    `,
    toInput: (row) => ({ nodeId: row.id, content: row.content }),
  },
  memory: {
    sql: `
      SELECT m.id::text AS id, m.content
      FROM memories m
      JOIN public.nodes n ON n.id = m.id
      WHERE m.content IS NOT NULL
        AND LENGTH(TRIM(m.content)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.embeddings e
          WHERE e.node_id = m.id::text AND e.model_id = $1 AND e.updated_at >= n.updated_at
        )
      ORDER BY n.updated_at ASC
      LIMIT $2
    `,
    toInput: (row) => ({ nodeId: row.id, content: row.content }),
  },
  thread_summary: {
    sql: `
      SELECT s.id::text AS id, s.summary_text AS content
      FROM thread_summaries s
      JOIN public.nodes n ON n.id = s.id
      WHERE s.summary_text IS NOT NULL
        AND LENGTH(TRIM(s.summary_text)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.embeddings e
          WHERE e.node_id = s.id::text AND e.model_id = $1 AND e.updated_at >= n.updated_at
        )
      ORDER BY n.updated_at ASC
      LIMIT $2
    `,
    toInput: (row) => ({ nodeId: row.id, content: row.content }),
  },
  doc: {
    sql: `
      SELECT d.id::text AS id,
             COALESCE(NULLIF(TRIM(d.title), ''), '') ||
               CASE WHEN COALESCE(NULLIF(TRIM(d.title), ''), '') <> ''
                     AND COALESCE(NULLIF(TRIM(d.content), ''), '') <> ''
                    THEN E'\\n\\n' ELSE '' END ||
               COALESCE(NULLIF(TRIM(d.content), ''), '') AS content
      FROM docs d
      JOIN public.nodes n ON n.id = d.id
      WHERE ((d.title IS NOT NULL AND LENGTH(TRIM(d.title)) > 0)
          OR (d.content IS NOT NULL AND LENGTH(TRIM(d.content)) > 0))
        AND NOT EXISTS (
          SELECT 1 FROM public.embeddings e
          WHERE e.node_id = d.id::text AND e.model_id = $1 AND e.updated_at >= n.updated_at
            AND e.chunk_index >= 0
        )
      ORDER BY n.updated_at ASC
      LIMIT $2
    `,
    // The freshness EXISTS requires a BODY-chunk row (chunk_index >= 0): a
    // Require a body chunk so stale reserved rows left by an older database
    // cannot mask a missing body embedding during the removal migration.
    toInput: (row) => ({ nodeId: row.id, content: row.content }),
  },
};

/**
 * Tools carry a composed payload rather than one column, so they get their own
 * staleness query. Shared with `getEmbeddingQueueDepth` — same params
 * ($1 = model id, $2 = limit) as every entry in STALE_QUERIES.
 */
const TOOL_STALE_SQL = `
      SELECT t.id, t.name, t.description, t.category_path, t.type, t.keywords, t.aliases, t.parameters_schema
      FROM tools t
      JOIN public.nodes n ON n.id = t.id
      WHERE NOT EXISTS (
        SELECT 1 FROM public.embeddings e
        WHERE e.node_id = t.id AND e.model_id = $1 AND e.updated_at >= n.updated_at
      )
      ORDER BY n.updated_at ASC
      LIMIT $2
    `;

/**
 * Provider for sweep work, or null when sweeping can't run this tick: the
 * test mock, or the local embedder's model files are missing on disk.
 *
 * A missing provider or missing model files is an error state, not a
 * supported configuration. Missing files trigger the automatic reseed
 * (`reseedEmbedderIfMissing`: single-flight, cooldown-throttled, and the one
 * that logs) and this tick waits; the sweep resumes once the download lands.
 */
async function resolveSweepProvider(): Promise<EmbeddingProvider | null> {
  const provider = await resolveEmbeddingProvider();
  if (!provider) {
    // The local provider always resolves, so reaching this is a programming
    // error upstream, never a supported configuration.
    logger.error(
      '[EmbeddingWorker] no embedding provider resolved — the local embedder should always resolve; sweep skipped'
    );
    return null;
  }
  if (provider instanceof MockEmbeddingProvider) return null;
  if (provider.info.provider === LOCAL_EMBEDDER_PROVIDER_ID) {
    const status = await getLocalEmbedderStatus();
    if (!status.ready) {
      void reseedEmbedderIfMissing('embedding sweep').catch((err: unknown) => {
        // reseed logs its own failures; never let the sweep tick reject here.
        logger.warn(`[EmbeddingWorker] embedder reseed kick failed: ${getErrorMessage(err)}`);
      });
      return null;
    }
  }
  return provider;
}

async function processStaleNode(nodeType: EmbeddableKind, batch: number): Promise<number> {
  // Tools need a composed payload (DB row + optional TOOL.md) rather than a
  // single column from SQL — handled by a dedicated path.
  if (nodeType === 'tool') return processStaleTool(batch);
  // Files are content-addressed (one chunk set per unique content, shared by
  // every referencing file row) — handled by a dedicated path.
  if (nodeType === 'file') return processStaleFile(batch);

  const query = STALE_QUERIES[nodeType as keyof typeof STALE_QUERIES];
  if (!query) return 0;

  const provider = await resolveSweepProvider();
  if (!provider) return 0;
  const modelRow = await Models.findByProviderAndModelId(
    provider.info.provider,
    provider.info.model
  );
  if (!modelRow) return 0;

  const pool = getDb();
  const { rows } = await pool.query<{ id: string; content: string }>(query.sql, [
    modelRow.id,
    batch,
  ]);
  if (rows.length === 0) return 0;

  let processed = 0;
  for (const row of rows) {
    try {
      const target = await buildEmbeddingTarget(nodeType as EmbeddingNodeType, row.id);
      if (!target) continue;
      const classified = await classifyEmbeddingTarget(target, modelRow.id);
      if (classified.state === 'fresh') {
        await Embeddings.touchByNodeModel(row.id, modelRow.id);
        continue;
      }
      const result = await embedNode({
        nodeId: target.nodeId,
        content: target.content,
        providerOverride: provider,
        expectedNodeUpdatedAt: target.sourceUpdatedAt,
      });
      if (result.ok) processed += 1;
    } catch (err) {
      logger.error(`[EmbeddingWorker] failed to embed stale ${nodeType} ${row.id}`, err);
    }
  }
  return processed;
}

async function processStaleFile(batch: number): Promise<number> {
  const provider = await resolveSweepProvider();
  if (!provider) return 0;
  const { embedded, reused } = await sweepMissingFileEmbeddings(batch, provider);
  if (reused > 0) {
    // The zero-compute path: these contents were already embedded (another
    // project/worktree references the same bytes) — no provider calls made.
    logger.info(
      `[EmbeddingWorker] file sweep reused ${reused} existing content embedding(s) (zero compute)`
    );
  }
  return embedded;
}

async function processStaleTool(batch: number): Promise<number> {
  // Short-circuit when embedding can't run — otherwise every tick reads 20
  // tool rows + runs composer + hits embedNode only to fail at the provider
  // step. Single-call check is cheap (file-presence probe at most).
  const provider = await resolveSweepProvider();
  if (!provider) return 0;
  const modelRow = await Models.findByProviderAndModelId(
    provider.info.provider,
    provider.info.model
  );
  if (!modelRow) return 0;

  const pool = getDb();
  const { rows } = await pool.query<ToolDbRow>(TOOL_STALE_SQL, [modelRow.id, batch]);
  if (rows.length === 0) return 0;

  const fsMap = getToolFsMap();
  let processed = 0;
  for (const row of rows) {
    try {
      const composed = composeToolEmbeddingText(row, fsMap.get(row.id));
      const result = await embedNode({
        nodeId: row.id,
        content: composed.text,
        providerOverride: provider,
      });
      if (result.ok) processed += 1;
    } catch (err) {
      logger.error(`[EmbeddingWorker] failed to embed stale tool ${row.id}`, err);
    }
  }
  return processed;
}

async function sweepAutomaticEmbeddings(policy: ResolvedWorkerPolicy): Promise<number> {
  if (!policy.embeddingsEnabled) return 0;
  // Sweep each kind on the policy's cadence (the base tick can be faster, so
  // this gates whether a kind runs on a given tick, not how often we wake).
  let total = 0;
  for (const node of PERIODIC_NODES) {
    const last = lastPeriodicRun.get(node) ?? 0;
    if (elapsedMs(last) < policy.effectiveSweepIntervalMs) continue;

    const processed = await processStaleNode(node, policy.effectiveBatchSize);
    lastPeriodicRun.set(node, Date.now());
    total += processed;
    if (processed > 0) {
      logger.info(`[EmbeddingWorker] embedded ${processed} stale ${node}(s)`);
    }
  }
  return total;
}

/**
 * Pending (missing or stale) embedding work per node kind, reusing the exact
 * predicates the sweep itself runs so the number a user sees can't drift from
 * what the worker will actually pick up.
 *
 * Each count is bounded by `cap` (the predicates already carry `LIMIT $2`, so
 * wrapping them in a COUNT keeps the scan bounded) — a capped kind reports the
 * cap and the response flags `capped`, meaning "at least this many".
 *
 * `file` is excluded: file embeddings are content-addressed and shared across
 * every row referencing the same bytes, so a per-node count would be
 * misleading. Its backlog is reported by the embedding coverage surfaces.
 */
export async function getEmbeddingQueueDepth(cap = 500): Promise<WorkerQueueDepth> {
  const empty: WorkerQueueDepth = { total: 0, capped: false, cap, byKind: {}, ready: false };

  const active = await embeddingSettings.getActiveModel();
  const modelRow = await Models.findByProviderAndModelId(active.providerId, active.modelId);
  if (!modelRow) return empty;

  const pool = getDb();
  const byKind: Record<string, number> = {};
  let total = 0;
  let capped = false;

  const countFor = async (kind: string, sql: string): Promise<void> => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM (${sql}) AS candidates`,
      [modelRow.id, cap]
    );
    const n = Number(rows[0]?.n ?? 0);
    byKind[kind] = n;
    total += n;
    if (n >= cap) capped = true;
  };

  for (const [kind, query] of Object.entries(STALE_QUERIES)) {
    await countFor(kind, query.sql);
  }
  await countFor('tool', TOOL_STALE_SQL);

  return { total, capped, cap, byKind, ready: true };
}

async function sweepSettledEdits(): Promise<void> {
  // Re-embed docs whose human edits have settled (changed + idle). Deferred by
  // autosave so per-keystroke saves don't spam the embedding model; this is the
  // doc-search freshness path. Best-effort.
  try {
    const reembedded = await sweepSettledDocReembeds();
    if (reembedded > 0) {
      logger.info(`[EmbeddingWorker] re-embedded ${reembedded} settled doc edit(s)`);
    }
  } catch (err) {
    logger.error('[EmbeddingWorker] settled-doc re-embed sweep failed', err);
  }
}

/**
 * Arm (or re-arm) the timer at `tickMs`. A no-op when it is already armed at
 * that cadence, so a mode change that doesn't move the cadence doesn't reset
 * the countdown.
 */
function arm(tickMs: number): void {
  if (timer !== null && armedTickMs === tickMs) return;
  if (timer !== null) clearInterval(timer);
  armedTickMs = tickMs;
  timer = setInterval(runTick, tickMs);
}

function disarm(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  armedTickMs = 0;
}

/**
 * Bring the timer in line with the policy. `off` (or a stopped worker) means
 * no timer at all; every other mode keeps one alive at the policy's cadence —
 * `paused` included, so resuming is just the next tick seeing a new mode.
 */
function applyPolicyToTimer(policy: ResolvedWorkerPolicy): void {
  if (!desired || policy.stopped) {
    disarm();
    return;
  }
  arm(policy.tickIntervalMs);
}

async function tick(): Promise<void> {
  if (running) return; // reentrancy guard
  running = true;
  beginSweep(EMBEDDING_WORKER_ID);
  try {
    // Re-read every pass: pausing from the UI must take effect without a
    // restart, and the cadence/batch may have changed since the last tick.
    const policy = await resolveWorkerPolicy();
    applyPolicyToTimer(policy);
    if (!policy.active) {
      endSweep(EMBEDDING_WORKER_ID, { outcome: 'skipped' });
      return;
    }

    const automaticLocalIntelligenceEnabled = isAutomaticLocalIntelligenceEnabled();
    let processed = 0;
    await runEmbeddingWorkerLanes({
      automaticLocalIntelligenceEnabled,
      sweepAutomaticEmbeddings: async () => {
        processed = await sweepAutomaticEmbeddings(policy);
      },
      sweepSettledEdits: () => sweepSettledEdits(),
      sweepTableEntries: async () => {
        processed += await sweepTableEntries();
      },
    });
    endSweep(EMBEDDING_WORKER_ID, { outcome: 'ok', processed });
  } catch (err) {
    endSweep(EMBEDDING_WORKER_ID, { outcome: 'error', error: getErrorMessage(err) });
    // Programmer-bug SQL errors (undefined_column etc.) re-throw — every
    // tick would fail the same way, and silently looping wastes log volume
    // and embedding-quota. Per-row LLM errors stay swallowed inside the
    // inner loop above.
    rethrowIfProgrammerError(err);
    logger.error('[EmbeddingWorker] tick failed', err);
  } finally {
    running = false;
  }
}

function runTick(): void {
  currentTick = tick().finally(() => {
    currentTick = null;
  });
}

/**
 * Re-read the policy and re-arm/tear down accordingly. Called at start and on
 * every `workers.*` settings change, which is what makes `off → balanced`
 * resume a stopped loop without a server restart.
 */
async function reconcilePolicy(): Promise<void> {
  if (!desired) return;
  let policy: ResolvedWorkerPolicy;
  try {
    policy = await resolveWorkerPolicy();
  } catch (err) {
    logger.warn(`[EmbeddingWorker] policy reconcile failed: ${getErrorMessage(err)}`);
    return;
  }
  applyPolicyToTimer(policy);
  // Kick a pass right away so a user switching to immediate (or resuming from
  // paused) sees work start now rather than one interval from now.
  if (policy.active && !running) runTick();
}

export function startEmbeddingWorker(): void {
  if (desired) return;
  desired = true;
  registerWorker(EMBEDDING_WORKER_ID);
  logger.info('[EmbeddingWorker] starting (cadence follows the workers.mode setting)');
  if (policyUnsubscribe === null) {
    policyUnsubscribe = onWorkerPolicyChange(() => {
      void reconcilePolicy();
    });
  }
  void reconcilePolicy();
}

/** Hard cap on waiting for an in-flight tick at shutdown. Ticks can include
 * model calls (summary lanes) that take arbitrarily long; every sweep is
 * restart-resumable (progress lives in the DB), so abandoning one is cheap.
 * The cap only exists to let a fast tick close its DB clients cleanly. */
const STOP_TICK_GRACE_MS = 3_000;

export async function stopEmbeddingWorker(): Promise<void> {
  const wasRunning = desired || timer !== null;
  desired = false;
  if (policyUnsubscribe) {
    policyUnsubscribe();
    policyUnsubscribe = null;
  }
  disarm();
  if (currentTick) {
    const abandoned = Symbol('abandoned');
    const result = await Promise.race([
      currentTick.catch((err) =>
        logger.error('[EmbeddingWorker] in-flight tick failed during shutdown', err)
      ),
      new Promise((resolve) => setTimeout(resolve, STOP_TICK_GRACE_MS, abandoned)),
    ]);
    if (result === abandoned) {
      logger.warn(
        `[EmbeddingWorker] in-flight tick still running after ${STOP_TICK_GRACE_MS}ms — abandoning (sweeps are restart-resumable)`
      );
    }
  }
  if (wasRunning) {
    logger.info('[EmbeddingWorker] stopped');
  }
}
