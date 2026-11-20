import { Model } from '@snaglet/db/Model';
import type { DbQueryable } from '@snaglet/db/db';

export interface FeatureFlagRow {
  id: string;
  name: string;
  enabled: boolean;
}

class FeatureFlagModelClass extends Model<FeatureFlagRow> {
  constructor() {
    super({
      table: 'feature_flags',
      primaryKey: 'id',
      createdAtColumn: null,
      updatedAtColumn: null,
    });
  }

  /** Read a deterministic subset for an exposure surface. */
  async listByNames(
    names: readonly string[],
    runner: DbQueryable = this.pool
  ): Promise<FeatureFlagRow[]> {
    if (names.length === 0) return [];
    const result = await runner.query<FeatureFlagRow>(
      `SELECT id, name, enabled
         FROM public.feature_flags
        WHERE name = ANY($1::text[])
        ORDER BY name ASC`,
      [[...names]]
    );
    return result.rows;
  }

  /** Missing and unknown names deliberately fail closed. */
  async isEnabled(name: string, runner: DbQueryable = this.pool): Promise<boolean> {
    const result = await runner.query<{ enabled: boolean }>(
      `SELECT enabled
         FROM public.feature_flags
        WHERE name = $1`,
      [name]
    );
    return result.rows[0]?.enabled === true;
  }
}

export const FeatureFlags = new FeatureFlagModelClass();
