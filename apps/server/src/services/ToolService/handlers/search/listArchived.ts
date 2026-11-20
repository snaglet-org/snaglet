import { getDb } from '@snaglet/db';
import { helperThreadContentExclusionSql } from '@snaglet/db/tables/threads/visibility';
import { clamp } from '@snaglet/shared/utils';

interface WorkspaceListArchivedInput {
  type?: string;
  limit?: number;
}

interface ArchivedRow {
  id: string;
  type: string;
  archived_at: string | null;
  container_id: string | null;
  ttl_remaining_days: number | null;
}

interface ListResult {
  success: boolean;
  count: number;
  items: ArchivedRow[];
  message: string;
}

const TTL_DAYS = 30;

export default async function execute(params: WorkspaceListArchivedInput): Promise<ListResult> {
  const limit = clamp(params.limit ?? 100, 1, 500);
  const pool = getDb();

  // Subagent helper threads (and anything in them) are never listed.
  const conditions: string[] = ['archived = true', helperThreadContentExclusionSql('nodes.id')];
  const values: unknown[] = [];
  if (params.type) {
    values.push(params.type);
    conditions.push(`type = $${values.length}`);
  }
  values.push(limit);

  const { rows } = await pool.query<{
    id: string;
    type: string;
    archived_at: string | null;
    container_id: string | null;
    ttl_remaining_days: number | null;
  }>(
    `SELECT
       id,
       type,
       archived_at::text AS archived_at,
       container_id,
       CASE
         WHEN archived_at IS NULL THEN NULL
         ELSE GREATEST(
           0,
           CEIL(EXTRACT(EPOCH FROM (archived_at + INTERVAL '${TTL_DAYS} days' - NOW())) / 86400)::int
         )
       END AS ttl_remaining_days
     FROM nodes
     WHERE ${conditions.join(' AND ')}
     ORDER BY archived_at DESC NULLS LAST
     LIMIT $${values.length}`,
    values
  );

  return {
    success: true,
    count: rows.length,
    items: rows,
    message:
      rows.length === 0
        ? 'No archived nodes match the filter.'
        : `${rows.length} archived node(s) listed (TTL=${TTL_DAYS} days from archive time).`,
  };
}
