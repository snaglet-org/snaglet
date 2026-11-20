import {
  classifySemanticEntries,
  embedSemanticEntryTarget,
} from './tableSemantic/TableSemanticService';
import { randomUUID } from 'crypto';
import { removeAllIneligibleMessageEmbeddings } from './embedding/injectedMessageCleanup';
import { getDb } from '@snaglet/db/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { FileEmbeddings } from '@snaglet/db/tables/files';
import { Models, type ModelRow } from '@snaglet/db/tables/models';
import { getErrorMessage, isoNow, sleep } from '@snaglet/shared/utils';
import { embedNode } from './embedding/EmbeddingOrchestrator';
import { embedFileContent } from './embedding/fileContentEmbedding';
import {
  BACKFILL_EMBEDDING_NODE_TYPES,
  classifyEmbeddingTargets,
  isEmbeddingNodeType,
  listEmbeddingTargets,
  type EmbeddingNodeType,
} from './embedding/EmbeddingNodeClassifier';
import {
  probeEmbeddingModel,
  resolveEmbeddingProviderForModel,
  type EmbeddingProvider,
} from './embedding/EmbeddingProvider';
import { embeddingSettings } from './embedding/EmbeddingSettings';
import { getLocalEmbedderStatus } from './embedding/LocalEmbedderService';
import {
  LOCAL_EMBEDDER_MODEL_ID,
  LOCAL_EMBEDDER_PROVIDER_ID,
} from './embedding/embedderModelManifest';
import { logger } from '@server/config/logger';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { emitFileEmbeddingCoverageChanged } from '@server/realtime/surfaces/fileEmbeddings';

export type EmbeddingMaintenanceOperation = 'backfill';

interface EmbeddingMaintenanceNodeTypeCoverage {
  nodeType: EmbeddingNodeType | 'table_entry';
  fresh: number;
  missing: number;
  stale: number;
}

/** Coverage for Snaglet's one embedding model, the built-in local one. */
export interface EmbeddingMaintenanceModel {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  existing: number;
  missing: number;
  stale: number;
  fresh: number;
  storageBytes: number;
  estimatedMissingTokens: number;
  estimatedStaleTokens: number;
  nodeTypeCoverage: EmbeddingMaintenanceNodeTypeCoverage[];
}

export interface EmbeddingMaintenanceStatus {
  running: boolean;
  jobId: string | null;
  operation: EmbeddingMaintenanceOperation | null;
  modelId: string | null;
  providerId: string | null;
  modelKey: string | null;
  requestedNodeType: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  cancelRequested: boolean;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  deleted: number;
  estimatedTokensTotal: number;
  estimatedTokensProcessed: number;
  currentNodeType: string | null;
  currentNodeId: string | null;
  lastError: string | null;
}

const INITIAL_STATUS: EmbeddingMaintenanceStatus = {
  running: false,
  jobId: null,
  operation: null,
  modelId: null,
  providerId: null,
  modelKey: null,
  requestedNodeType: null,
  startedAt: null,
  finishedAt: null,
  cancelledAt: null,
  cancelRequested: false,
  total: 0,
  processed: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  deleted: 0,
  estimatedTokensTotal: 0,
  estimatedTokensProcessed: 0,
  currentNodeType: null,
  currentNodeId: null,
  lastError: null,
};

let status: EmbeddingMaintenanceStatus = { ...INITIAL_STATUS };

function cloneStatus(): EmbeddingMaintenanceStatus {
  return { ...status };
}

function isBuiltinLocalModel(row: ModelRow): boolean {
  return row.providerId === LOCAL_EMBEDDER_PROVIDER_ID && row.modelId === LOCAL_EMBEDDER_MODEL_ID;
}

/** The catalog row a maintenance job runs against: only the built-in local model. */
async function getModelOrThrow(modelId: string): Promise<ModelRow> {
  const row = await Models.findById(modelId);
  if (!row || !row.isActive) {
    throw new Error('Embedding model not found or inactive.');
  }
  if (!isBuiltinLocalModel(row)) {
    throw new Error(
      `${row.providerId}:${row.modelId} is not Snaglet's embedding model. Snaglet embeds with its built-in local model (${LOCAL_EMBEDDER_PROVIDER_ID}:${LOCAL_EMBEDDER_MODEL_ID}).`
    );
  }
  return row;
}

/** The built-in local model's catalog row, or null when it is missing or inactive. */
async function findBuiltinModelRow(): Promise<ModelRow | null> {
  const active = await embeddingSettings.getActiveModel();
  const row = await Models.findByProviderAndModelId(active.providerId, active.modelId);
  return row?.isActive ? row : null;
}

// Node embeddings + content-addressed file embeddings (file_embeddings) —
// files are not in public.embeddings, so totals span both tables.
async function countEmbeddings(modelId?: string): Promise<number> {
  const db = getDb();
  const { rows } = await db.query<{ count: string }>(
    modelId
      ? `SELECT COUNT(*)::text AS count FROM public.embeddings WHERE model_id = $1`
      : `SELECT COUNT(*)::text AS count FROM public.embeddings`,
    modelId ? [modelId] : []
  );
  return Number(rows[0]?.count ?? 0) + (await FileEmbeddings.countRows(modelId));
}

async function countEmbeddingStorageBytes(modelId: string): Promise<number> {
  const db = getDb();
  const { rows } = await db.query<{ bytes: string }>(
    `SELECT
       (SELECT COALESCE(SUM(pg_column_size(e.*)), 0)
          FROM public.embeddings e WHERE e.model_id = $1)
     + (SELECT COALESCE(SUM(pg_column_size(fe.*)), 0)
          FROM public.file_embeddings fe WHERE fe.model_id = $1) AS bytes`,
    [modelId]
  );
  return Number(rows[0]?.bytes ?? 0);
}

/**
 * Coverage for the maintenance view. Snaglet has one embedding model, so the list
 * holds the built-in local model's row, or nothing when the catalog lacks it.
 */
export async function listMaintenanceModels(): Promise<EmbeddingMaintenanceModel[]> {
  const model = await findBuiltinModelRow();
  if (!model) return [];
  const targets = await listEmbeddingTargets(BACKFILL_EMBEDDING_NODE_TYPES);
  const tableEntries = await classifySemanticEntries();
  const [classified, existing, storageBytes] = await Promise.all([
    classifyEmbeddingTargets(targets, model.id),
    countEmbeddings(model.id),
    countEmbeddingStorageBytes(model.id),
  ]);
  const missing = classified.filter((target) => target.state === 'missing');
  const stale = classified.filter((target) => target.state === 'stale');
  const fresh = classified.filter((target) => target.state === 'fresh');
  return [
    {
      id: model.id,
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.displayName || model.modelId,
      existing,
      missing: missing.length,
      stale: stale.length,
      fresh: fresh.length,
      storageBytes,
      estimatedMissingTokens: missing.reduce((sum, target) => sum + target.estimatedTokens, 0),
      estimatedStaleTokens: stale.reduce((sum, target) => sum + target.estimatedTokens, 0),
      nodeTypeCoverage: [
        ...BACKFILL_EMBEDDING_NODE_TYPES.map((nodeType) => {
          const rows = classified.filter((target) => target.nodeType === nodeType);
          return {
            nodeType,
            fresh: rows.filter((target) => target.state === 'fresh').length,
            missing: rows.filter((target) => target.state === 'missing').length,
            stale: rows.filter((target) => target.state === 'stale').length,
          };
        }),
        {
          nodeType: 'table_entry',
          fresh: tableEntries.fresh,
          missing: tableEntries.missing,
          stale: tableEntries.stale,
        },
      ],
    },
  ];
}

async function runEmbedJob(
  jobId: string,

  model: ModelRow,
  provider: EmbeddingProvider,
  requestedNodeType: EmbeddingNodeType | 'table_entry' | null
): Promise<void> {
  try {
    const nodeTypes =
      requestedNodeType === 'table_entry'
        ? []
        : requestedNodeType
          ? [requestedNodeType]
          : BACKFILL_EMBEDDING_NODE_TYPES;
    const targets = nodeTypes.length ? await listEmbeddingTargets(nodeTypes) : [];
    const selected = (
      targets.length ? await classifyEmbeddingTargets(targets, model.id) : []
    ).filter((target) => target.state !== 'fresh');
    const tableTargets =
      !requestedNodeType || requestedNodeType === 'table_entry'
        ? (await classifySemanticEntries()).target
        : [];
    if (status.jobId !== jobId) return;
    status.total = selected.length + tableTargets.length;
    status.estimatedTokensTotal = selected.reduce((sum, target) => sum + target.estimatedTokens, 0);

    for (const target of selected) {
      if (status.jobId !== jobId) return;
      if (status.cancelRequested) {
        status.cancelledAt = isoNow();
        return;
      }
      status.currentNodeType = target.nodeType;
      status.currentNodeId = target.nodeId;
      try {
        // Files persist content-addressed (one chunk set per unique content);
        // duplicate references later in the same job dedup to 'unchanged'.
        const result =
          target.nodeType === 'file'
            ? await embedFileContent({
                contentHash: target.contentHash,
                content: target.content,
                providerOverride: provider,
              })
            : await embedNode({
                nodeId: target.nodeId,
                content: target.content,
                providerOverride: provider,
                expectedNodeUpdatedAt: target.sourceUpdatedAt,
              });
        if (result.ok) status.succeeded += 1;
        else if (
          result.skipped === 'empty' ||
          result.skipped === 'unchanged' ||
          result.skipped === 'superseded'
        )
          status.skipped += 1;
        else {
          status.failed += 1;
          status.lastError = result.error ?? 'Embedding failed.';
        }
      } catch (err) {
        status.failed += 1;
        status.lastError = getErrorMessage(err);
      }
      status.processed += 1;
      status.estimatedTokensProcessed += target.estimatedTokens;
    }
    for (const target of tableTargets) {
      if (status.jobId !== jobId || status.cancelRequested) return;
      status.currentNodeType = 'table_entry';
      status.currentNodeId = target.entryId;
      try {
        if (await embedSemanticEntryTarget(target)) status.succeeded++;
        else status.skipped++;
      } catch (error) {
        status.failed++;
        status.lastError = getErrorMessage(error);
      }
      status.processed++;
    }
  } catch (err) {
    status.lastError = getErrorMessage(err);
  } finally {
    if (status.jobId === jobId) {
      status.running = false;
      status.finishedAt = isoNow();
      status.currentNodeType = null;
      status.currentNodeId = null;
    }
  }
}

export function getMaintenanceStatus(): EmbeddingMaintenanceStatus {
  return cloneStatus();
}

export function cancelMaintenanceJob(): EmbeddingMaintenanceStatus {
  if (status.running) status.cancelRequested = true;
  return cloneStatus();
}

export async function startMaintenanceJob(input: {
  operation: EmbeddingMaintenanceOperation;
  modelId?: string | null;
  /** Optional content kind; table entries use the independent table-semantic index. */
  nodeType?: string | null;
}): Promise<EmbeddingMaintenanceStatus> {
  if (status.running) {
    throw new Error('An embedding maintenance job is already running.');
  }

  const operation = input.operation;
  const nodeType = (input.nodeType ?? '').trim() || null;
  if (operation !== 'backfill') throw new Error('Only unified backfill is supported.');
  const requestedNodeType =
    nodeType === 'table_entry'
      ? 'table_entry'
      : nodeType
        ? isEmbeddingNodeType(nodeType)
          ? nodeType
          : null
        : null;
  if (nodeType && !requestedNodeType) throw new Error('Unsupported backfill kind.');
  const model = await getModelOrThrow((input.modelId ?? '').trim());
  const builtin = await embeddingSettings.getActiveModel();
  const probeError = await probeEmbeddingModel(builtin);
  if (probeError) throw new Error(probeError);
  const provider = await resolveEmbeddingProviderForModel(builtin);
  if (!provider) throw new Error('Embedding provider unavailable.');

  // Provider probing yields; another manual request may have claimed the slot.
  if (status.running) throw new Error('An embedding maintenance job is already running.');
  const jobId = randomUUID();
  status = {
    ...INITIAL_STATUS,
    running: true,
    jobId,
    operation,
    modelId: model?.id ?? null,
    providerId: model?.providerId ?? null,
    modelKey: model ? `${model.providerId}:${model.modelId}` : null,
    requestedNodeType,
    startedAt: isoNow(),
  };

  void runEmbedJob(jobId, model, provider, requestedNodeType);

  return cloneStatus();
}

export async function startBackfillForActiveModel(): Promise<EmbeddingMaintenanceStatus> {
  const active = await embeddingSettings.getActiveModel();
  const model = await Models.findByProviderAndModelId(active.providerId, active.modelId);
  if (!model) {
    throw new Error(
      'The built-in embedding model is missing from the models catalog. Restart Snaglet to restore it.'
    );
  }
  return startMaintenanceJob({ operation: 'backfill', modelId: model.id });
}

// Startup backfill — the re-embed job that repopulates an empty embeddings
// table (e.g. content restored without embeddings).

/** How often to re-check embedder readiness while the model downloads. */
const STARTUP_BACKFILL_POLL_MS = 30_000;
/** Give the first-run background download up to 30 minutes before giving up. */
const STARTUP_BACKFILL_MAX_POLLS = 60;

/** Local derived-data cleanup runs even when automatic embedding is disabled. */
export async function cleanupStartupMessageEmbeddings(): Promise<number> {
  const deleted = await removeAllIneligibleMessageEmbeddings();
  logger.info(`[embedding] startup message cleanup — deleted ${deleted} ineligible vector(s)`);
  return deleted;
}

/**
 * Fire-and-forget after explicit local-intelligence opt-in: once the local
 * embedder's model files are present, start a `backfill_missing` job if any
 * embeddable node lacks an embedding for the local model.
 *
 * Properties the caller can rely on:
 * - non-blocking: awaits nothing on the startup path; polls readiness in the
 *   background and no-ops if the download never lands (the 1-minute staleness
 *   sweep remains the safety net).
 * - content_hash-aware: work runs through `embedNode`, which skips unchanged
 *   (nodeId, modelId, contentHash) rows.
 * - resumable: progress is persisted per node in the embeddings table, and
 *   the job selects only MISSING targets — a restart mid-backfill simply
 *   picks up the remainder.
 */
export async function ensureStartupEmbeddingBackfill(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!isAutomaticLocalIntelligenceEnabled(env)) return;
  for (let attempt = 0; attempt < STARTUP_BACKFILL_MAX_POLLS; attempt += 1) {
    const embedder = await getLocalEmbedderStatus();
    if (embedder.ready) break;
    if (attempt === STARTUP_BACKFILL_MAX_POLLS - 1) {
      logger.warn(
        '[embedding] startup backfill skipped — local embedder model never became ready. ' +
          'The staleness sweep will backfill once it is installed.'
      );
      return;
    }
    await sleep(STARTUP_BACKFILL_POLL_MS);
  }

  if (status.running) return; // a manual job beat us to it

  const model = await Models.findByProviderAndModelId(
    LOCAL_EMBEDDER_PROVIDER_ID,
    LOCAL_EMBEDDER_MODEL_ID
  );
  if (!model) {
    logger.warn(
      '[embedding] startup backfill skipped — local embedder model row missing from the catalog ' +
        '(restart Snaglet to restore it).'
    );
    return;
  }

  const targets = await listEmbeddingTargets(BACKFILL_EMBEDDING_NODE_TYPES);
  const classified = await classifyEmbeddingTargets(targets, model.id);
  const missing = classified.filter((target) => target.state === 'missing').length;
  if (missing === 0) {
    return;
  }

  logger.info(
    `[embedding] startup backfill — ${missing} node(s) missing local embeddings, starting background re-embed`
  );
  try {
    await startMaintenanceJob({ operation: 'backfill', modelId: model.id });
  } catch (err) {
    // "already running" is fine — someone started a job between our check and now.
    logger.warn(`[embedding] startup backfill not started: ${getErrorMessage(err)}`);
  }
}
