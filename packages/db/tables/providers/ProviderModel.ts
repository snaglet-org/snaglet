/**
 * ProviderModel — Model class for the providers table.
 *
 * Extends the base Model with provider-specific query methods
 * (list ordered by sort_order, update primary credential).
 */

import { Model } from '@snaglet/db/Model';
import type { ProviderDefaultMetadata } from '@snaglet/shared/types/metadata';

/**
 * Row shape returned by `Model.query` / `findById`. The base Model layer
 * transforms snake_case DB columns to camelCase, so consumers see this shape.
 */
type ProviderType = 'llm' | 'integration' | 'runtime';

export interface ProviderRow {
  id: string;
  name: string;
  description: string;
  website: string | null;
  apiDocs: string | null;
  status: string | null;
  baseUrl: string | null;
  type: ProviderType;
  enabled: boolean;
  sortOrder: number;
  primaryCredentialId: string | null;
  defaultMetadata: ProviderDefaultMetadata;
  createdAt: string;
  updatedAt: string;
}

class ProviderModelClass extends Model<ProviderRow> {
  constructor() {
    super({
      table: 'providers',
      primaryKey: 'id',
    });
  }

  /** List all providers ordered by sort_order then name. */
  async listAll(): Promise<ProviderRow[]> {
    return this.query<ProviderRow>(`SELECT * FROM providers ORDER BY sort_order, name`);
  }

  /** Find a single provider by id. */
  async findProvider(id: string): Promise<ProviderRow | null> {
    return this.findById(id);
  }

  /** Set (or clear) the primary credential for a provider. */
  async updatePrimaryCredential(
    providerId: string,
    credentialId: string | null
  ): Promise<ProviderRow | null> {
    return this.queryOne<ProviderRow>(
      `UPDATE providers
          SET primary_credential_id = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [providerId, credentialId]
    );
  }

  /**
   * Update a provider's `base_url`. Pass `null` to clear it; providers that
   * need a local base URL then read their corresponding `.env` variable.
   */
  async updateBaseUrl(providerId: string, baseUrl: string | null): Promise<ProviderRow | null> {
    return this.queryOne<ProviderRow>(
      `UPDATE providers
          SET base_url = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [providerId, baseUrl]
    );
  }

  async setEnabled(providerId: string, enabled: boolean): Promise<ProviderRow | null> {
    return this.queryOne<ProviderRow>(
      `UPDATE providers SET enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [providerId, enabled]
    );
  }
}

export const Providers = new ProviderModelClass();
