/**
 * UserProviderCredentialModel — Model class for the user_provider_credentials table.
 *
 * Extends the base Model with credential-specific query methods
 * (find by provider, update tokens, update verification status, partial update).
 */

import { Model } from '@snaglet/db/Model';

/**
 * Row shape returned by `Model.query` / `findById`. The base Model layer
 * transforms snake_case DB columns to camelCase, so consumers see this shape.
 */
export interface UserProviderCredentialRow {
  id: string;
  providerId: string;
  authTypeId: string;
  authType: string;
  label: string;
  encryptedSecret: string;
  /**
   * Encrypted multi-field credential bundle (AES-GCM of a JSON object),
   * alongside encryptedSecret for complex / multi-field MCP credentials. NULL
   * for single-secret rows.
   */
  encryptedBundle: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  verificationStatus: 'untested' | 'ok' | 'fail';
}

export interface CreateUserProviderCredentialInput {
  id: string;
  providerId: string;
  authTypeId: string;
  authType: string;
  label: string;
  encryptedSecret: string;
  /** Encrypted multi-field bundle (AES-GCM of a JSON object) for complex creds. */
  encryptedBundle?: string | null;
  metadataJson?: Record<string, unknown>;
}

class UserProviderCredentialModelClass extends Model<
  UserProviderCredentialRow,
  CreateUserProviderCredentialInput
> {
  constructor() {
    super({
      table: 'user_provider_credentials',
      primaryKey: 'id',
    });
  }

  /**
   * Delete a credential AND clear any agent or thread participant that had it
   * pinned, so those actors fall back to the provider primary (no credential =
   * use the provider default) instead of dangling on a deleted id. There is no
   * FK on agents.credential_id / thread_participants.credential_id, so this
   * cleanup is the only thing that prevents orphaned pins when a credential is
   * replaced or removed — and every credential-deletion path funnels through
   * here. `providers.primary_credential_id` and `provider_fallback_credentials`
   * already self-heal via their own ON DELETE constraints.
   */
  override async delete(id: string | number): Promise<boolean> {
    await this.pool.query('UPDATE agents SET credential_id = NULL WHERE credential_id = $1', [id]);
    await this.pool.query(
      'UPDATE thread_participants SET credential_id = NULL WHERE credential_id = $1',
      [id]
    );
    return super.delete(id);
  }

  /** List all credentials ordered by most recently updated. */
  async listAll(): Promise<UserProviderCredentialRow[]> {
    return this.query<UserProviderCredentialRow>(
      `SELECT * FROM user_provider_credentials ORDER BY updated_at DESC`
    );
  }

  /** Find a credential by provider_id (most recently updated). */
  async findByProviderId(providerId: string): Promise<UserProviderCredentialRow | null> {
    return this.queryOne<UserProviderCredentialRow>(
      `SELECT *
       FROM user_provider_credentials
       WHERE provider_id = $1
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [providerId]
    );
  }

  /**
   * Rotate an OAuth credential: replace the encrypted access token, merge the
   * (non-secret) metadata patch, and — when provided — replace the encrypted
   * bundle that holds the refresh token. The metadata write also strips any
   * plaintext `refresh_token` key from older rows on their first rotation;
   * secrets never live in `metadata_json`.
   *
   * Note: `- 'refresh_token'` runs before the `|| $3` merge, so a stray
   * `refresh_token` left in `metadataPatch` would survive — callers must peel it
   * into `encryptedBundle` first (see ProviderCredentialService.peelRefreshToken).
   */
  async updateTokens(
    id: string,
    encryptedSecret: string,
    metadataPatch: Record<string, unknown>,
    encryptedBundle?: string
  ): Promise<void> {
    const sets = [
      'encrypted_secret = $2',
      "metadata_json = (metadata_json - 'refresh_token') || $3::jsonb",
    ];
    const vals: unknown[] = [id, encryptedSecret, JSON.stringify(metadataPatch)];
    if (encryptedBundle !== undefined) {
      vals.push(encryptedBundle);
      sets.push(`encrypted_bundle = $${vals.length}`);
    }
    sets.push('updated_at = NOW()');
    await this.pool.query(
      `UPDATE user_provider_credentials SET ${sets.join(', ')} WHERE id = $1`,
      vals
    );
  }

  /** Update the verification status of a credential. */
  async updateVerificationStatus(id: string, status: 'untested' | 'ok' | 'fail'): Promise<void> {
    await this.pool.query(
      `UPDATE user_provider_credentials
       SET verification_status = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, status]
    );
  }

  /** Partial update of label, encrypted_secret, encrypted_bundle, and/or metadata_json. */
  async patch(
    id: string,
    patch: {
      label?: string;
      encryptedSecret?: string;
      encryptedBundle?: string | null;
      metadataJson?: Record<string, unknown>;
    }
  ): Promise<UserProviderCredentialRow | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;

    if (patch.label !== undefined) {
      sets.push(`label = $${++idx}`);
      vals.push(patch.label);
    }
    if (patch.encryptedSecret !== undefined) {
      sets.push(`encrypted_secret = $${++idx}`);
      vals.push(patch.encryptedSecret);
    }
    if (patch.encryptedBundle !== undefined) {
      sets.push(`encrypted_bundle = $${++idx}`);
      vals.push(patch.encryptedBundle);
    }
    if (patch.metadataJson !== undefined) {
      sets.push(`metadata_json = $${++idx}::jsonb`);
      vals.push(JSON.stringify(patch.metadataJson));
    }
    if (sets.length === 0) return this.findById(id);

    sets.push('updated_at = NOW()');
    const rows = await this.query<UserProviderCredentialRow>(
      `UPDATE user_provider_credentials SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...vals]
    );
    return rows[0] ?? null;
  }
}

export const UserProviderCredentials = new UserProviderCredentialModelClass();
