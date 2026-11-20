/**
 * EmbeddingOrchestrator — canonical write path for node embeddings.
 *
 * Takes a `nodeId` and the text to embed. Callers (who already know what
 * the node is) supply the content; the orchestrator handles dedup hashing,
 * provider resolution, and persistence.
 *
 * Responsibilities:
 *   - hash content for dedup (skip-re-embed via findByNodeModelHash)
 *   - delegate embedding generation to the embedding provider (the built-in
 *     local model)
 *   - persist to the embeddings table via EmbeddingModel
 *
 * Non-responsibilities:
 *   - HTTP / provider transport shapes → EmbeddingProvider
 *   - node-specific preprocessing (e.g. block hydration) → caller-supplied hook
 */

import { Embeddings, type EmbeddingChunkInput } from '@snaglet/db/tables/embeddings';
import { Models } from '@snaglet/db/tables/models';
import { Messages } from '@snaglet/db/tables/messages';
import { isEmbeddableMessage } from './messageEligibility';
import { isHiddenThread } from '@server/services/subagents/helperVisibility';
import { resolveEmbeddingProvider, type EmbeddingProvider } from './EmbeddingProvider';
import { chunkContent, contentBudgetChars } from './chunkContent';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { embeddingContentHash, normalizeEmbeddingContent } from './contentHash';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { LOCAL_EMBEDDER_MAX_SEQUENCE_TOKENS } from './embedderModelManifest';

/**
 * Resolve the canonical `models` row for a (providerId, modelId) pair. The
 * embeddings table FKs into models.id, but provider info only carries the
 * stable provider+model strings, and a `models.id` may be a UUID rather than
 * a `"<provider>:<model>"` composite, so the id must be looked up.
 *
 * Returns null when the model row isn't in the DB. Callers must treat that
 * as a hard failure — the built-in model's row is seeded and restored at
 * boot, so a missing row indicates the catalog is out of sync.
 */
async function resolveModelRow(
  providerId: string,
  modelKey: string
): Promise<{ id: string; contextWindowTokens: number | null } | null> {
  const row = await Models.findByProviderAndModelId(providerId, modelKey);
  return row ? { id: row.id, contextWindowTokens: row.contextWindowTokens ?? null } : null;
}

/**
 * Adaptive budget shrink for token-dense content. The chars-per-token
 * heuristic underestimates tokens for code/SQL/JSON, so a chunk that fits
 * the char budget can still exceed the model's real token window. Each
 * overflow rejection shrinks the budget 40% and re-chunks: 0.6^2 of the
 * initial budget reaches ~2 chars/token territory, denser than any real
 * text tokenizes.
 */
const MAX_BUDGET_ATTEMPTS = 3;
const BUDGET_SHRINK_FACTOR = 0.6;
const MIN_BUDGET_CHARS = 400;

/** Provider messages that mean "this input exceeds the model's context window". */
function isContextOverflowError(message: string): boolean {
  return /context length|input length|too many tokens|maximum (context|input|token)|exceeds.*(length|limit)|input is too (long|large)/i.test(
    message
  );
}

export interface EmbeddingModelRowInfo {
  id: string;
  contextWindowTokens: number | null;
}

export type GenerateChunksResult =
  | { ok: true; chunks: EmbeddingChunkInput[] }
  | { ok: false; error: string };

/**
 * Chunk `prepared` to the model's window and embed every chunk, with the
 * adaptive budget-shrink retry on context overflow. Shared by the node write
 * path (embedNode) and the content-addressed file path (embedFileContent) so
 * both apply identical chunking, dim guards, and provider error handling.
 * Returns the chunk rows WITHOUT persisting them.
 */
export async function generateEmbeddingChunks(
  prepared: string,
  provider: EmbeddingProvider,
  modelRow: EmbeddingModelRowInfo,
  logContext: Record<string, unknown> = {}
): Promise<GenerateChunksResult> {
  // The built-in model's catalog row records its window; a row without one
  // (test fixtures) gets the local model's own input ceiling.
  const maxInputTokens = modelRow.contextWindowTokens ?? LOCAL_EMBEDDER_MAX_SEQUENCE_TOKENS;
  const expectedDim = provider.info.dimensions;

  let budgetChars = contentBudgetChars(maxInputTokens);
  for (let attempt = 0; attempt < MAX_BUDGET_ATTEMPTS; attempt++) {
    const chunks = chunkContent(prepared, { maxChars: budgetChars });

    // Embed sequentially — the local embedder serializes anyway, and a
    // failure on chunk k aborts the whole set before any row is written, so
    // search never sees a partially-embedded document.
    const rows: EmbeddingChunkInput[] = [];
    let overflowed = false;
    for (const chunk of chunks) {
      let vector: number[];
      try {
        vector = await provider.embedDocument(chunk.text);
      } catch (err) {
        const message = getErrorMessage(err);
        if (isContextOverflowError(message) && attempt < MAX_BUDGET_ATTEMPTS - 1) {
          overflowed = true;
          break; // shrink the budget and re-chunk the whole document
        }
        logger.warn('[EmbeddingOrchestrator] Provider failed', {
          provider: provider.info.provider,
          model: provider.info.model,
          chunk: `${chunk.index + 1}/${chunks.length}`,
          budgetChars,
          err: message,
        });
        return { ok: false, error: message };
      }

      // The produced vector must match the active model's declared dimension
      // (provider.info.dimensions). Search scopes by model_id, so mixed-width
      // rows coexist safely; a mismatch here is a genuine provider/catalog bug.
      if (vector.length !== expectedDim) {
        logger.warn(
          `[EmbeddingOrchestrator] Active model ${provider.info.provider}:${provider.info.model} produced ${vector.length}-dim vector — model declares ${expectedDim}. Skipping.`
        );
        return {
          ok: false,
          error:
            `${provider.info.provider}:${provider.info.model} returned a ${vector.length}-dimension vector ` +
            `but Snaglet expects ${expectedDim} dimensions.`,
        };
      }

      rows.push({
        vector,
        chunkIndex: chunk.index,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
      });
    }

    if (!overflowed) return { ok: true, chunks: rows };
    const shrunk = Math.max(MIN_BUDGET_CHARS, Math.floor(budgetChars * BUDGET_SHRINK_FACTOR));
    logger.info(
      '[EmbeddingOrchestrator] Context overflow — shrinking chunk budget and re-chunking',
      { ...logContext, fromChars: budgetChars, toChars: shrunk, attempt: attempt + 1 }
    );
    budgetChars = shrunk;
  }

  // Exhausted shrink attempts and the model still rejects the input.
  return {
    ok: false,
    error:
      `${provider.info.provider}:${provider.info.model} rejected the content as exceeding its ` +
      'context window even at the smallest chunk size.',
  };
}

export interface EmbedNodeInput {
  /** Node id of the node being embedded. */
  nodeId: string;
  /** Raw content. If `preprocess` is provided, it will be called first. */
  content: string | null | undefined;
  /** Optional transform (e.g. block hydration, tag stripping) before embedding. */
  preprocess?: (content: string) => string | Promise<string>;
  /** Explicit provider/model for maintenance jobs; normal writes use the active model. */
  providerOverride?: EmbeddingProvider | null;
  /**
   * Optional source version captured before provider inference. Persistence
   * locks the node and compares this value so a slow result cannot overwrite
   * a newer edit.
   */
  expectedNodeUpdatedAt?: string;
}

export interface EmbedNodeResult {
  ok: boolean;
  skipped?: 'empty' | 'no-provider' | 'provider-error' | 'unchanged' | 'superseded' | 'ineligible';
  model?: string;
  provider?: string;
  contentHash?: string;
  /** Number of chunk rows written (1 for content within the model's window). */
  chunks?: number;
  /**
   * User-facing failure reason for non-ok results. Surfaces (re-embed job
   * status) forward this verbatim so the user learns
   * why the embed failed — e.g. the model files are missing and
   * `pnpm embedder:fetch` downloads them — instead of a silent skip.
   */
  error?: string;
}

/**
 * Embed a node and persist the result. Safe to call with empty content
 * (no-ops). Skips persistence if (nodeId, modelId, contentHash) already
 * exists.
 */
export async function embedNode(input: EmbedNodeInput): Promise<EmbedNodeResult> {
  const { nodeId, content, preprocess, providerOverride, expectedNodeUpdatedAt } = input;
  if (!nodeId) return { ok: false, skipped: 'empty' };

  // Check the canonical row, not caller text or API role. This guard applies
  // to inline writes and manual callers as well as background sweeps.
  const message = await Messages.findById(nodeId);
  if (message && !isEmbeddableMessage(message)) {
    await Embeddings.deleteByNodeId(nodeId);
    return { ok: false, skipped: 'ineligible', error: 'Injected messages are not embeddable.' };
  }
  // Helper and DM threads stay out of search, so their messages get no vector
  // (and lose any they had). The sweeps apply the same rule in SQL.
  if (message && (await isHiddenThread(message.threadId))) {
    await Embeddings.deleteByNodeId(nodeId);
    return {
      ok: false,
      skipped: 'ineligible',
      error: 'Messages in a subagent helper thread or a DM thread are not embeddable.',
    };
  }

  const raw = normalizeEmbeddingContent(content);
  if (!raw) return { ok: false, skipped: 'empty' };

  const prepared = preprocess ? normalizeEmbeddingContent(await preprocess(raw)) : raw;
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

  const hash = embeddingContentHash(prepared);
  const modelRow = await resolveModelRow(provider.info.provider, provider.info.model);
  if (!modelRow) {
    logger.warn(
      `[EmbeddingOrchestrator] No models row for ${provider.info.provider}:${provider.info.model}. ` +
        `Refusing to write an embedding that would violate embeddings_model_id_fkey.`
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

  // Skip re-embed if identical (nodeId, modelId, contentHash) already stored.
  // Chunk sets share the full content's hash, so one lookup covers both the
  // single-row and chunked cases.
  const existing = await Embeddings.findByNodeModelHash(nodeId, modelRow.id, hash);
  if (existing) {
    // Content unchanged — no re-embed. Touch the row's updated_at so the
    // staleness sweep (which flags nodes whose embedding is older than their
    // content) stops re-selecting this node every tick once it's caught up.
    await Embeddings.touchByNodeModel(nodeId, modelRow.id);
    return {
      ok: true,
      skipped: 'unchanged',
      model: provider.info.model,
      provider: provider.info.provider,
      contentHash: hash,
    };
  }

  // Split to the model's context window. Content that fits comes back as a
  // single chunk, so the common case is unchanged. The window comes from the
  // built-in model's catalog row (seeded with the embedder's input ceiling),
  // so long content is chunked rather than silently truncated.
  //
  // The char budget is a HEURISTIC (~4 chars/token holds for prose, but
  // code/SQL/JSON tokenize denser, ~2.5-3 chars/token) — so when the
  // provider rejects a chunk for exceeding the context window, shrink the
  // budget and re-chunk instead of failing. Adaptive retry beats a tighter
  // global estimate: prose keeps big efficient chunks, dense content
  // converges to what the model actually accepts. All handled by
  // generateEmbeddingChunks, shared with the file content path.
  const generated = await generateEmbeddingChunks(prepared, provider, modelRow, { nodeId });
  if (!generated.ok) {
    return {
      ok: false,
      skipped: 'provider-error',
      model: provider.info.model,
      provider: provider.info.provider,
      error: generated.error,
    };
  }
  const chunkRows = generated.chunks;

  const persisted = expectedNodeUpdatedAt
    ? await Embeddings.replaceChunks(nodeId, modelRow.id, hash, chunkRows, {
        expectedNodeUpdatedAt,
      })
    : await Embeddings.replaceChunks(nodeId, modelRow.id, hash, chunkRows);
  if (persisted === null) {
    return {
      ok: false,
      skipped: 'superseded',
      model: provider.info.model,
      provider: provider.info.provider,
      contentHash: hash,
    };
  }

  if (chunkRows.length > 1) {
    logger.info('[EmbeddingOrchestrator] Chunked long content', {
      nodeId,
      chunks: chunkRows.length,
      contentChars: prepared.length,
    });
  }

  return {
    ok: true,
    model: provider.info.model,
    provider: provider.info.provider,
    contentHash: hash,
    chunks: chunkRows.length,
  };
}

/**
 * Fire-and-forget immediate embed for a discrete write (doc/task create,
 * agent tool writes, etc.). Automatic write-side inference is policy-gated;
 * explicit embed routes call `embedNode` directly and remain available.
 */
export function embedNodeNow(nodeId: string, content: string | null | undefined): void {
  if (!isAutomaticLocalIntelligenceEnabled() || !nodeId || !content?.trim()) return;
  void embedNode({ nodeId, content }).catch((err) => {
    logger.warn('[embedding] immediate embed failed', {
      nodeId,
      err: getErrorMessage(err),
    });
  });
}
