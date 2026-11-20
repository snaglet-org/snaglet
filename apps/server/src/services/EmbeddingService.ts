/**
 * EmbeddingService — public facade for message embeddings.
 *
 * The embed pipeline lives in `embedding/EmbeddingOrchestrator`.
 * This module keeps a stable public surface (`syncMessageEmbedding`,
 * `generateDocumentEmbedding`, `generateQueryEmbedding`) so callers outside
 * the embedding subsystem don't churn, but internally it delegates to the
 * orchestrator + provider.
 *
 * - `syncMessageEmbedding`        → orchestrator (hash → provider → DB → GNN)
 * - `generateDocumentEmbedding`   → raw provider call for INDEX-side text the
 *                                   caller persists itself (memories, summaries)
 * - `generateQueryEmbedding`      → raw provider call for SEARCH queries
 *                                   (similarity ranking, recall)
 *
 * Document vs query is a method, not a parameter — backends that need task
 * prefixes (the local nomic-embed) apply them internally per method, so no
 * caller can forget or misapply a prefix.
 */

import { createHash } from 'crypto';
import { resolveEmbeddingProvider, type EmbeddingProvider } from './embedding/EmbeddingProvider';
import { embedNode } from './embedding/EmbeddingOrchestrator';
import { Models } from '@snaglet/db/tables/models';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';

interface EmbeddingResult {
  embedding: number[] | null;
  model: string;
  provider: string;
  cached: boolean;
  contentHash: string | null;
  /**
   * The `models.id` PK for the active provider+model, or null when the
   * catalog has no row. Persisting callers must write this id (never a
   * fabricated `"<provider>:<model>"` composite) — `embeddings.model_id`
   * FKs into `models(id)`.
   */
  modelRowId: string | null;
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function syncMessageEmbedding(messageId: string, content: string): Promise<void> {
  if (!isAutomaticLocalIntelligenceEnabled()) return;
  // Messages are discrete writes — embed immediately (content-hash dedup +
  // no-provider handling live in embedNode).
  await embedNode({ nodeId: messageId, content });
}

async function generateEmbedding(
  text: string,
  kind: 'document' | 'query'
): Promise<EmbeddingResult> {
  const provider: EmbeddingProvider | null = await resolveEmbeddingProvider();
  if (!provider) {
    return {
      embedding: null,
      model: '',
      provider: '',
      cached: false,
      contentHash: null,
      modelRowId: null,
    };
  }

  const hash = contentHash(text);

  try {
    const embedding =
      kind === 'document' ? await provider.embedDocument(text) : await provider.embedQuery(text);
    const row = await Models.findByProviderAndModelId(
      provider.info.provider,
      provider.info.model
    ).catch(() => null);
    return {
      embedding,
      model: provider.info.model,
      provider: provider.info.provider,
      cached: false,
      contentHash: hash,
      modelRowId: row?.id ?? null,
    };
  } catch (err) {
    logger.warn('[EmbeddingService] Failed to generate embedding:', getErrorMessage(err));
    return {
      embedding: null,
      model: provider.info.model,
      provider: provider.info.provider,
      cached: false,
      contentHash: null,
      modelRowId: null,
    };
  }
}

/**
 * Embed index-side content WITHOUT DB persistence — for callers that persist
 * the vector themselves (memories, summaries). For standard node embeddings,
 * prefer `embedNode` from the orchestrator.
 */
export async function generateDocumentEmbedding(text: string): Promise<EmbeddingResult> {
  return generateEmbedding(text, 'document');
}

/** Embed a search query for an in-memory similarity operation. */
export async function generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
  return generateEmbedding(text, 'query');
}
