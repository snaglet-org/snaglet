/**
 * ProviderAuthTypeModel — Model class for the provider_auth_types table.
 *
 * Extends the base Model with auth-type-specific query methods
 * (list by provider ID, list by multiple provider IDs).
 */

import { Model } from '@snaglet/db/Model';

/**
 * Row shape returned by `Model.query` / `findById`. The base Model layer
 * transforms snake_case DB columns to camelCase, so consumers see this shape.
 */
export interface ProviderAuthTypeRow {
  id: string;
  providerId: string;
  name: string;
  type: string;
  description: string;
  tokenLabel: string | null;
  tokenPlaceholder: string | null;
  tokenHelp: string | null;
  authHeader: string | null;
  sortOrder: number;
  createdAt: string;
}

class ProviderAuthTypeModelClass extends Model<ProviderAuthTypeRow> {
  constructor() {
    super({
      table: 'provider_auth_types',
      primaryKey: 'id',
      updatedAtColumn: null,
    });
  }

  /** List auth types for multiple provider IDs, ordered by provider then sort_order. */
  async listByProviderIds(providerIds: string[]): Promise<ProviderAuthTypeRow[]> {
    if (providerIds.length === 0) return [];
    return this.query<ProviderAuthTypeRow>(
      `SELECT *
       FROM provider_auth_types
       WHERE provider_id = ANY($1)
       ORDER BY provider_id, sort_order`,
      [providerIds]
    );
  }

  /** List auth types for a single provider ID, ordered by sort_order. */
  async listByProviderId(providerId: string): Promise<ProviderAuthTypeRow[]> {
    return this.query<ProviderAuthTypeRow>(
      `SELECT *
       FROM provider_auth_types
       WHERE provider_id = $1
       ORDER BY sort_order`,
      [providerId]
    );
  }
}

export const ProviderAuthTypes = new ProviderAuthTypeModelClass();
