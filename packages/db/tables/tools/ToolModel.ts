/**
 * ToolModel — Model class for the tools table.
 *
 * Extends the base Model with tool-specific query methods
 * (list by type, tier, active status, upsert).
 */

import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { Nodes } from '@snaglet/db/tables/nodes';
import { NODE_KIND } from '@snaglet/shared/constants';
import type { CreateToolInput, ToolRow, ToolTier, UpdateToolInput } from '@snaglet/shared/types';

// Row + input shapes are the shared db↔wire schema — see
// packages/shared/types/tools.ts. Re-exported so existing `@snaglet/db` /
// `@snaglet/db/tables/tools` consumers keep their import sites.
export type { CreateToolInput, ToolRow, ToolTier, UpdateToolInput };

class ToolModelClass extends Model<ToolRow, CreateToolInput, UpdateToolInput> {
  constructor() {
    super({
      table: 'tools',
      primaryKey: 'id',
    });
  }

  /** List all tools ordered by sort_order then name. */
  async listAll(): Promise<ToolRow[]> {
    return this.query<ToolRow>(`SELECT * FROM tools ORDER BY sort_order, name`);
  }

  /** List tools that pass the durable per-tool admin gate. */
  async listResolvable(): Promise<ToolRow[]> {
    return this.query<ToolRow>(
      `SELECT * FROM tools WHERE enabled = TRUE ORDER BY sort_order, name`
    );
  }

  /** List enabled tools filtered by type. */
  async listByType(type: 'builtin' | 'mcp' | 'external'): Promise<ToolRow[]> {
    return this.query<ToolRow>(
      `SELECT * FROM tools WHERE type = $1 AND enabled = TRUE ORDER BY sort_order, name`,
      [type]
    );
  }

  /** List enabled tools filtered by tier. */
  async listByTier(tier: ToolTier): Promise<ToolRow[]> {
    return this.query<ToolRow>(
      `SELECT * FROM tools WHERE tier = $1 AND enabled = TRUE ORDER BY sort_order, name`,
      [tier]
    );
  }

  /** Find a tool by its source field (e.g. 'workspace:my-tool'). */
  async findBySource(source: string): Promise<ToolRow | null> {
    const rows = await this.query<ToolRow>(`SELECT * FROM tools WHERE source = $1 LIMIT 1`, [
      source,
    ]);
    return rows[0] ?? null;
  }

  /**
   * Delete a tool row. Unlike containers/docs/etc., `tools.id` carries no FK
   * to `nodes.id`, so the node deletion is explicit. The base `Model.delete()`
   * only removes the `tools` row, which would orphan the `nodes` row
   * (type='tool') and its `embeddings` row (embeddings.node_id does cascade
   * from `nodes.id`, so deleting the node reaps the embedding too). One transaction so the node-spine and type-table deletes can't
   * tear (same pattern as ThreadSummaryModel.insertNewVersion); node first,
   * matching the spine-before-type ordering the rest of the codebase uses.
   */
  override async delete(id: string): Promise<boolean> {
    return transaction(async (tx) => {
      await Nodes.deleteOfType(id, NODE_KIND.TOOL, tx);
      const { rowCount } = await tx.query(`DELETE FROM ${this.qualifiedTable} WHERE id = $1`, [id]);
      return (rowCount ?? 0) > 0;
    });
  }

  /**
   * Admin policy toggle. Writes only `enabled`; reachability is derived
   * from credentials at read time, not stored on the row.
   */
  async setEnabled(id: string, enabled: boolean): Promise<ToolRow | null> {
    return this.queryOne<ToolRow>(
      `UPDATE tools SET enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, enabled]
    );
  }

  /** Find resolvable tools by a list of IDs. Same gate as listResolvable. */
  async findActiveByIds(ids: string[]): Promise<Pick<ToolRow, 'id' | 'name'>[]> {
    if (ids.length === 0) return [];
    return this.query<Pick<ToolRow, 'id' | 'name'>>(
      `SELECT id, name FROM tools WHERE id = ANY($1) AND enabled = TRUE`,
      [ids]
    );
  }

  /**
   * Resolve a tool by alias. Returns the canonical active tool whose
   * `aliases` array contains the given name, or null.
   *
   * Used by the dispatcher to resolve hallucinated tool names
   * Lookups are case-sensitive and exact — alias
   * normalization (trimming, lowercasing) happens at the call site.
   */
  async findByAlias(alias: string): Promise<ToolRow | null> {
    const rows = await this.query<ToolRow>(
      `SELECT * FROM tools
       WHERE $1 = ANY(COALESCE(aliases, '{}'::text[]))
         AND enabled = TRUE
       LIMIT 1`,
      [alias]
    );
    return rows[0] ?? null;
  }

  /**
   * List all active tools, with `assigned` indicating whether the tool
   * passes the agent's tool-access config (toolAccessMode + allow/deny lists
   * on flat `agents` columns).
   *
   * Used by the list_tools tool.
   */
  async listAvailableForAgent(agentId: string): Promise<
    {
      id: string;
      name: string;
      description: string;
      type: string;
      tier: string;
      sortOrder: number;
      assigned: boolean;
      keywords: string[];
      aliases: string[];
      parametersSchema: Record<string, unknown>;
    }[]
  > {
    return this.query(
      `WITH cfg AS (
         SELECT
           COALESCE(tool_access_mode, 'all') AS mode,
           COALESCE(
             ARRAY(SELECT jsonb_array_elements_text(tool_access_allow_list)),
             '{}'::text[]
           ) AS allow_list,
           COALESCE(
             ARRAY(SELECT jsonb_array_elements_text(tool_access_deny_list)),
             '{}'::text[]
           ) AS deny_list
         FROM agents
         WHERE id = $1
       )
       SELECT
         t.id,
         t.name,
         t.description,
         t.type,
         t.tier,
         t.sort_order,
         COALESCE(t.keywords, '{}') AS keywords,
         COALESCE(t.aliases, '{}') AS aliases,
         COALESCE(t.parameters_schema, '{}'::jsonb) AS parameters_schema,
         CASE
           WHEN (SELECT mode FROM cfg) = 'allow_list' THEN
             t.id = ANY(COALESCE((SELECT allow_list FROM cfg), '{}'::text[]))
             OR t.name = ANY(COALESCE((SELECT allow_list FROM cfg), '{}'::text[]))
           WHEN (SELECT mode FROM cfg) = 'deny_list' THEN
             NOT (t.id = ANY(COALESCE((SELECT deny_list FROM cfg), '{}'::text[]))
                  OR t.name = ANY(COALESCE((SELECT deny_list FROM cfg), '{}'::text[])))
           ELSE TRUE
         END AS assigned
       FROM tools t
       WHERE t.enabled = TRUE
       ORDER BY t.tier = 'core' DESC, t.sort_order, t.name`,
      [agentId]
    );
  }

  /**
   * Create an external tool with runner config. Returns the created tool row.
   */
  async createExternalTool(input: {
    id: string;
    name: string;
    description: string;
    parametersSchema?: Record<string, unknown>;
    source: string;
    configJson: Record<string, unknown>;
    enabled?: boolean;
    sortOrder?: number;
  }): Promise<ToolRow> {
    const existing = await this.findById(input.id);
    if (existing) {
      throw new Error(`A tool with id "${input.id}" already exists`);
    }

    await Nodes.ensure(input.id, NODE_KIND.TOOL);

    const rows = await this.query<ToolRow>(
      `INSERT INTO tools (id, name, description, type, parameters_schema, source, config_json, enabled, sort_order, category_path)
       VALUES ($1, $2, $3, 'external', $4::jsonb, $5, $6::jsonb, $7, $8, 'custom')
       RETURNING *`,
      [
        input.id,
        input.name,
        input.description,
        JSON.stringify(input.parametersSchema ?? {}),
        input.source,
        JSON.stringify(input.configJson),
        input.enabled ?? true,
        input.sortOrder ?? 0,
      ]
    );

    return rows[0];
  }

  /** Upsert a tool by id — insert or update on conflict. */
  async upsertTool(input: CreateToolInput): Promise<ToolRow> {
    await this.ensureColumnMap();

    // ON CONFLICT intentionally omits `enabled`: admin policy must survive
    // every McpService reconnect. registerToolsInDb calls this on every
    // connect; if we re-stamped enabled here a server restart would wipe an
    // admin's per-tool disable.
    const enabled = input.enabled ?? true;

    const sql = `
      INSERT INTO tools (
        id,
        name,
        description,
        type,
        parameters_schema,
        keywords,
        source,
        config_json,
        enabled,
        tier,
        category_path,
        provider_id,
        sort_order,
        aliases
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        $6::text[],
        $7,
        $8::jsonb,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14::text[]
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        type = EXCLUDED.type,
        parameters_schema = EXCLUDED.parameters_schema,
        keywords = EXCLUDED.keywords,
        aliases = EXCLUDED.aliases,
        source = EXCLUDED.source,
        config_json = EXCLUDED.config_json,
        tier = EXCLUDED.tier,
        category_path = EXCLUDED.category_path,
        provider_id = EXCLUDED.provider_id,
        sort_order = EXCLUDED.sort_order,
        updated_at = NOW()
      RETURNING *
    `;

    const values = [
      input.id,
      input.name,
      input.description ?? '',
      input.type,
      JSON.stringify(input.parametersSchema ?? {}),
      input.keywords ?? [],
      input.source ?? null,
      JSON.stringify(input.configJson ?? {}),
      enabled,
      input.tier ?? 'standard',
      input.categoryPath ?? 'uncategorized',
      input.providerId ?? null,
      input.sortOrder ?? 100,
      input.aliases ?? [],
    ];

    // One transaction so the node-spine writes (ensure + touch) and the
    // tools-row upsert can't tear — a crash between them would otherwise
    // leave a tools row with no node (breaking the embedding sweep's JOIN)
    // or a touched node with a stale row.
    return transaction(async (tx) => {
      await Nodes.ensure(input.id, NODE_KIND.TOOL, { runner: tx });

      const { rows } = await tx.query<Record<string, unknown>>(sql, values);

      // Bump the node's `updated_at` so the embedding sweep (EmbeddingWorker's
      // processStaleTool) notices a content change. Its staleness query gates
      // on `nodes.updated_at`, not `tools.updated_at` (this SQL's own
      // `updated_at = NOW()` above only touches the latter), and `Nodes.ensure`
      // is `ON CONFLICT DO NOTHING`, so without this an edited tool's node row
      // keeps its original insert time and the sweep's
      // `e.updated_at >= n.updated_at` check reads as "already fresh" forever.
      await Nodes.touch(input.id, tx);

      return this.transformRow<ToolRow>(rows[0]) as ToolRow;
    });
  }
}

export const Tools = new ToolModelClass();
