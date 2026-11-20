/**
 * SettingsModel — DAL for the public.settings table, keyed by (category, key).
 *
 * Values are JSONB; callers (the typed registry in
 * apps/server/src/services/settings) own validation and defaults. Absence of
 * a row means "use the registry default."
 */

import { Model } from '@snaglet/db/Model';

export interface SettingRow {
  category: string;
  key: string;
  /** JSONB payload. Caller (registry) validates the shape. */
  value: unknown;
  updatedAt: string;
  updatedByUserId: string | null;
  updatedByAgentId: string | null;
}

export interface SettingsWriteActor {
  userId?: string | null;
  agentId?: string | null;
}

class SettingsModelClass extends Model<SettingRow> {
  constructor() {
    super({
      table: 'settings',
      // Composite PK: the Model base only uses primaryKey for single-key
      // operations (findById etc.) which we don't expose here. Reads/writes
      // are explicit (read/listByCategory/write/delete) and take both
      // category + key, so the base's primaryKey field is unused.
      primaryKey: 'category',
      updatedAtColumn: 'updated_at',
      columnMap: {
        updatedAt: 'updated_at',
        updatedByUserId: 'updated_by_user_id',
        updatedByAgentId: 'updated_by_agent_id',
      },
    });
  }

  /** Read one setting row. Returns null when the override doesn't exist. */
  async read(category: string, key: string): Promise<SettingRow | null> {
    const row = await this.queryOne<Record<string, unknown>>(
      `SELECT category, key, value, updated_at, updated_by_user_id, updated_by_agent_id
         FROM public.settings
        WHERE category = $1 AND key = $2`,
      [category, key]
    );
    return row ? this.transformRow<SettingRow>(row) : null;
  }

  /** All overrides in a category, ordered by key. */
  async listByCategory(category: string): Promise<SettingRow[]> {
    const rows = await this.query<Record<string, unknown>>(
      `SELECT category, key, value, updated_at, updated_by_user_id, updated_by_agent_id
         FROM public.settings
        WHERE category = $1
        ORDER BY key`,
      [category]
    );
    return this.transformRows<SettingRow>(rows);
  }

  /** Every override row in the table. Used by the admin list endpoint. */
  async listAll(): Promise<SettingRow[]> {
    const rows = await this.query<Record<string, unknown>>(
      `SELECT category, key, value, updated_at, updated_by_user_id, updated_by_agent_id
         FROM public.settings
        ORDER BY category, key`
    );
    return this.transformRows<SettingRow>(rows);
  }

  /**
   * Upsert a setting override. `value` is persisted as JSONB; pass any JSON-
   * compatible payload (the caller is responsible for schema validation).
   *
   * Concurrency: ON CONFLICT DO UPDATE — last writer wins atomically.
   * Actor: pass userId or agentId (not both); both-null is allowed for migration writes.
   */
  async write(
    category: string,
    key: string,
    value: unknown,
    actor: SettingsWriteActor = {}
  ): Promise<SettingRow> {
    const row = await this.queryOne<Record<string, unknown>>(
      `INSERT INTO public.settings
         (category, key, value, updated_at, updated_by_user_id, updated_by_agent_id)
       VALUES ($1, $2, $3::jsonb, now(), $4, $5)
       ON CONFLICT (category, key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = now(),
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_by_agent_id = EXCLUDED.updated_by_agent_id
       RETURNING category, key, value, updated_at, updated_by_user_id, updated_by_agent_id`,
      [category, key, JSON.stringify(value), actor.userId ?? null, actor.agentId ?? null]
    );
    if (!row) {
      throw new Error(`SettingsModel.write: upsert returned no row for (${category}, ${key})`);
    }
    return this.transformRow<SettingRow>(row)!;
  }

  /**
   * Remove an override. Idempotent — deleting a non-existent row is a no-op.
   * The registry default takes effect on the next read.
   *
   * Named `remove` (not `delete`) because the base Model's `delete(id)` takes
   * a single PK; our composite (category, key) PK can't satisfy that signature.
   */
  async remove(category: string, key: string): Promise<void> {
    await this.pool.query(`DELETE FROM public.settings WHERE category = $1 AND key = $2`, [
      category,
      key,
    ]);
  }
}

export const Settings = new SettingsModelClass();
