/**
 * ProviderFallbackCredentialModel — Model class for the provider_fallback_credentials table.
 *
 * Extends the base Model with fallback-credential-specific methods
 * (list by provider, add with auto-index, remove, remove all).
 */

import { Model } from '@snaglet/db/Model';

export interface ProviderFallbackCredentialRow {
  id: string;
  providerId: string;
  credentialId: string;
  fallbackIndex: number;
  createdAt: string;
}

class ProviderFallbackCredentialModelClass extends Model<ProviderFallbackCredentialRow> {
  constructor() {
    super({
      table: 'provider_fallback_credentials',
      primaryKey: 'id',
      updatedAtColumn: null,
    });
  }

  /** List fallback credentials for a provider, ordered by index. */
  async listByProviderId(providerId: string): Promise<ProviderFallbackCredentialRow[]> {
    return this.query<ProviderFallbackCredentialRow>(
      `SELECT * FROM provider_fallback_credentials
       WHERE provider_id = $1
       ORDER BY fallback_index ASC`,
      [providerId]
    );
  }

  /** Add a fallback credential to a provider. Auto-assigns next index if not specified. */
  async addFallback(
    providerId: string,
    credentialId: string,
    fallbackIndex?: number
  ): Promise<ProviderFallbackCredentialRow> {
    let idx = fallbackIndex;
    if (idx === undefined) {
      const row = await this.queryOne<{ maxIdx: number | null }>(
        `SELECT MAX(fallback_index) AS max_idx FROM provider_fallback_credentials WHERE provider_id = $1`,
        [providerId]
      );
      idx = (row?.maxIdx ?? -1) + 1;
    }

    const result = await this.queryOne<ProviderFallbackCredentialRow>(
      `INSERT INTO provider_fallback_credentials (provider_id, credential_id, fallback_index)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider_id, credential_id) DO UPDATE SET fallback_index = EXCLUDED.fallback_index
       RETURNING *`,
      [providerId, credentialId, idx]
    );
    return result!;
  }

  /** Remove a fallback credential from a provider. */
  async removeFallback(providerId: string, credentialId: string): Promise<boolean> {
    const rows = await this.query(
      `DELETE FROM provider_fallback_credentials
       WHERE provider_id = $1 AND credential_id = $2
       RETURNING id`,
      [providerId, credentialId]
    );
    return rows.length > 0;
  }

  /** Remove all fallback credentials for a provider. */
  async removeAllForProvider(providerId: string): Promise<number> {
    const rows = await this.query(
      `DELETE FROM provider_fallback_credentials WHERE provider_id = $1 RETURNING id`,
      [providerId]
    );
    return rows.length;
  }
}

export const ProviderFallbackCredentials = new ProviderFallbackCredentialModelClass();
