/**
 * ModelModel — Model class for the models table.
 *
 * Extends the base Model with model-specific query methods
 * (list active by provider, create with upsert, deactivate, find by provider+model).
 */

import { Model } from '@snaglet/db/Model';
import type { ModelMetadata } from '@snaglet/shared/types/metadata';

function normalizeModelMetadata(metadata?: ModelMetadata): ModelMetadata {
  if (!metadata) return {};
  // deactivatedBy and limitsEditedBy are provenance owned by deactivateByUser
  // and the limit edits — never accepted from create/import payloads.
  const { dimensions, capabilities, deactivatedBy, limitsEditedBy, ...rest } = metadata;
  void dimensions;
  void capabilities;
  void deactivatedBy;
  void limitsEditedBy;
  return rest;
}

export interface ModelRow {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  description: string;
  family: string | null;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  isActive: boolean;
  sortOrder: number;
  type: string;
  dimensions: number | null;
  metadata: ModelMetadata;
  createdAt: string;
  updatedAt: string;
}

class ModelModelClass extends Model<ModelRow> {
  constructor() {
    super({
      table: 'models',
      primaryKey: 'id',
    });
  }

  /** List all models ordered by provider, sort_order, model_id. */
  async listAll(): Promise<ModelRow[]> {
    return this.query<ModelRow>(`SELECT * FROM models ORDER BY provider_id, sort_order, model_id`);
  }

  /** List active models for a provider, ordered by sort_order then model_id. */
  async listActiveByProviderId(providerId: string): Promise<ModelRow[]> {
    return this.query<ModelRow>(
      `SELECT * FROM models
       WHERE provider_id = $1 AND is_active = TRUE
       ORDER BY sort_order, model_id`,
      [providerId]
    );
  }

  /**
   * List all models for a provider (active and inactive), ordered by
   * sort_order then model_id. Used by entitlement reconciliation, which must
   * read cached probe verdicts on already-deactivated rows too.
   */
  async listByProviderId(providerId: string): Promise<ModelRow[]> {
    return this.query<ModelRow>(
      `SELECT * FROM models
       WHERE provider_id = $1
       ORDER BY sort_order, model_id`,
      [providerId]
    );
  }

  /**
   * Create a chat model (or reactivate if it already exists). New rows take
   * the column default `type = 'llm'`; Snaglet's only embedding model is the
   * built-in local row the seed manages. Limits given here were set by a
   * person or an agent, so the row is stamped `metadata.limitsEditedBy =
   * 'user'` and discovery leaves its limits alone.
   */
  async createModel(
    providerId: string,
    modelId: string,
    displayName?: string,
    metadata?: ModelMetadata,
    contextWindowTokens?: number | null,
    maxOutputTokens?: number | null
  ): Promise<ModelRow> {
    const result = await this.queryOne<ModelRow>(
      `INSERT INTO models (
         id, provider_id, model_id, display_name, description,
         context_window_tokens, max_output_tokens,
         is_active, sort_order, metadata
       )
       VALUES (
         gen_random_uuid(), $1, $2, $3, '', $4, $5, TRUE, 999,
         $6::jsonb || CASE WHEN $7 THEN '{"limitsEditedBy": "user"}'::jsonb ELSE '{}'::jsonb END
       )
       ON CONFLICT (provider_id, model_id) DO UPDATE SET
         is_active = TRUE,
         display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), models.display_name),
         context_window_tokens = COALESCE(EXCLUDED.context_window_tokens, models.context_window_tokens),
         max_output_tokens     = COALESCE(EXCLUDED.max_output_tokens, models.max_output_tokens),
         -- Explicit re-add clears the user-removal stamp so reconciliation
         -- treats the row as wanted again.
         metadata = ((CASE
           WHEN $6::jsonb = '{}'::jsonb THEN COALESCE(models.metadata, '{}'::jsonb)
           ELSE $6::jsonb
         END) - 'deactivatedBy')
           || CASE WHEN $7 THEN '{"limitsEditedBy": "user"}'::jsonb ELSE '{}'::jsonb END,
         updated_at = NOW()
       RETURNING *`,
      [
        providerId,
        modelId,
        displayName || modelId,
        contextWindowTokens ?? null,
        maxOutputTokens ?? null,
        JSON.stringify(normalizeModelMetadata(metadata)),
        contextWindowTokens != null || maxOutputTokens != null,
      ]
    );
    return result!;
  }

  /**
   * Bulk upsert models for a single provider. Returns the resulting rows.
   * Intended for the "import from provider /models API" flow.
   */
  async bulkUpsert(
    providerId: string,
    rows: Array<{
      modelId: string;
      displayName?: string;
      description?: string;
      family?: string | null;
      contextWindowTokens?: number | null;
      maxOutputTokens?: number | null;
      supportsTools?: boolean;
      supportsVision?: boolean;
      supportsReasoning?: boolean;
      metadata?: ModelMetadata;
    }>
  ): Promise<ModelRow[]> {
    if (rows.length === 0) return [];

    const out: ModelRow[] = [];
    for (const r of rows) {
      const result = await this.queryOne<ModelRow>(
        `INSERT INTO models (
           id, provider_id, model_id, display_name, description,
           family, context_window_tokens, max_output_tokens,
           supports_tools, supports_vision, supports_reasoning,
           is_active, sort_order, metadata
         )
         VALUES (
           gen_random_uuid(), $1, $2, $3, $4,
           $5, $6, $7,
           COALESCE($8, FALSE), COALESCE($9, FALSE), COALESCE($10, FALSE),
           TRUE, 999, $11::jsonb
         )
         ON CONFLICT (provider_id, model_id) DO UPDATE SET
           is_active   = TRUE,
           display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), models.display_name),
           description  = COALESCE(NULLIF(EXCLUDED.description, ''), models.description),
           family       = COALESCE(EXCLUDED.family, models.family),
           context_window_tokens = COALESCE(EXCLUDED.context_window_tokens, models.context_window_tokens),
           max_output_tokens     = COALESCE(EXCLUDED.max_output_tokens, models.max_output_tokens),
           supports_tools        = EXCLUDED.supports_tools,
           supports_vision       = EXCLUDED.supports_vision,
           supports_reasoning    = EXCLUDED.supports_reasoning,
           -- Explicit re-import clears the user-removal stamp so reconciliation
           -- treats the row as wanted again.
           metadata = (CASE
             WHEN EXCLUDED.metadata = '{}'::jsonb THEN COALESCE(models.metadata, '{}'::jsonb)
             ELSE EXCLUDED.metadata
           END) - 'deactivatedBy',
           updated_at = NOW()
         RETURNING *`,
        [
          providerId,
          r.modelId,
          r.displayName || r.modelId,
          r.description || '',
          r.family ?? null,
          r.contextWindowTokens ?? null,
          r.maxOutputTokens ?? null,
          r.supportsTools ?? null,
          r.supportsVision ?? null,
          r.supportsReasoning ?? null,
          JSON.stringify(normalizeModelMetadata(r.metadata)),
        ]
      );
      if (result) out.push(result);
    }
    return out;
  }

  /**
   * Update editable catalog fields for a model. `byUser` marks a person's edit:
   * when it sets a limit, the row is stamped `metadata.limitsEditedBy = 'user'`
   * (sibling-safe `jsonb_set`) so discovery never replaces that limit.
   */
  async updateModel(
    id: string,
    patch: {
      displayName?: string;
      contextWindowTokens?: number | null;
      maxOutputTokens?: number | null;
    },
    options: { byUser?: boolean } = {}
  ): Promise<ModelRow | null> {
    const setsWindow = Object.prototype.hasOwnProperty.call(patch, 'contextWindowTokens');
    const setsOutput = Object.prototype.hasOwnProperty.call(patch, 'maxOutputTokens');
    return this.queryOne<ModelRow>(
      `UPDATE models SET
         display_name = COALESCE(NULLIF($2, ''), display_name),
         context_window_tokens = CASE WHEN $3 THEN $4 ELSE context_window_tokens END,
         max_output_tokens = CASE WHEN $5 THEN $6 ELSE max_output_tokens END,
         metadata = CASE
           WHEN $7 THEN jsonb_set(COALESCE(metadata, '{}'::jsonb), '{limitsEditedBy}', '"user"'::jsonb, true)
           ELSE metadata
         END,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.displayName ?? null,
        setsWindow,
        patch.contextWindowTokens ?? null,
        setsOutput,
        patch.maxOutputTokens ?? null,
        options.byUser === true && (setsWindow || setsOutput),
      ]
    );
  }

  /**
   * Merge an entitlement verdict into a model's metadata and set its active
   * flag in one statement. `jsonb_set` preserves every other metadata key
   * (contextCompression, summary, …) — unlike bulkUpsert, which replaces the
   * whole metadata object.
   */
  async setEntitlement(
    id: string,
    entitlement: ModelMetadata['entitlement'],
    isActive: boolean
  ): Promise<void> {
    await this.query(
      `UPDATE models
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{entitlement}', $2::jsonb, true),
             is_active = $3,
             updated_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify(entitlement ?? {}), isActive]
    );
  }

  /** Deactivate a model by id. */
  async deactivate(id: string): Promise<boolean> {
    const rows = await this.query(
      `UPDATE models SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id]
    );
    return rows.length > 0;
  }

  /**
   * Deactivate a model at the user's explicit request, stamping
   * `metadata.deactivatedBy = 'user'` in the same statement (sibling-safe
   * `jsonb_set`, like setEntitlement). The stamp is provenance: reconciliation
   * passes skip user-removed rows instead of auto-resurrecting them, while
   * unstamped inactive rows (deactivated automatically) stay eligible for
   * reactivation. Cleared on explicit re-add (createModel/bulkUpsert).
   * Returns the removed model's provider id, or null when no row matched.
   */
  async deactivateByUser(id: string): Promise<string | null> {
    const row = await this.queryOne<{ providerId: string }>(
      `UPDATE models
         SET is_active = FALSE,
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{deactivatedBy}', '"user"'::jsonb, true),
             updated_at = NOW()
       WHERE id = $1
       RETURNING provider_id`,
      [id]
    );
    return row?.providerId ?? null;
  }

  /**
   * Provider type for a model (e.g. `'runtime'` for the built-in local
   * embedder/reranker), or null if the model doesn't exist. Used to keep
   * Snaglet-managed built-in models from being user-deleted.
   */
  async providerTypeOf(id: string): Promise<string | null> {
    const row = await this.queryOne<{ type: string }>(
      `SELECT p.type FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = $1`,
      [id]
    );
    return row?.type ?? null;
  }

  /** Find a model by provider_id and model_id. */
  async findByProviderAndModelId(providerId: string, modelId: string): Promise<ModelRow | null> {
    return this.queryOne<ModelRow>(
      `SELECT * FROM models
       WHERE provider_id = $1 AND model_id = $2
       LIMIT 1`,
      [providerId, modelId]
    );
  }
}

export const Models = new ModelModelClass();
