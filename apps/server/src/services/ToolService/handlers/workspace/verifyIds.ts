import { getDb } from '@snaglet/db';
import { isTableCatalogId } from '@snaglet/shared/types/tables';

interface VerifyIdsInput {
  ids: string[];
}

interface NodeRow {
  id: string;
  type: string | null;
  title: string | null;
  archived: boolean | null;
}

interface TableCatalogRow {
  id: string;
  name: string;
}

export default async function execute(input: VerifyIdsInput) {
  const ids = Array.isArray(input?.ids)
    ? input.ids.filter((x) => typeof x === 'string' && x.length > 0)
    : [];

  if (ids.length === 0) {
    return {
      verified: [],
      summary: { requested: 0, found: 0, not_found: 0 },
      note: 'No IDs supplied. Pass { ids: [...] }.',
    };
  }

  // De-dupe while preserving the caller's order for the report.
  const uniqueIds = Array.from(new Set(ids));
  // Database table catalog ids are not workspace node ids; they resolve
  // against public.table_catalog only and never touch public.nodes.
  const tableIds = uniqueIds.filter(isTableCatalogId);
  const nodeIds = uniqueIds.filter((id) => !isTableCatalogId(id));

  const pool = getDb();

  // Single batched query against the canonical nodes table, joined out to
  // type tables for a human-readable title. WHERE id = ANY($1) checks all
  // IDs at once. Mirrors workspace_get_node's join map.
  const [nodeResult, tableResult] = await Promise.all([
    nodeIds.length > 0
      ? pool.query<NodeRow>(
          `SELECT
             n.id,
             n.type,
             n.archived,
             COALESCE(d.title, c.name, n.id) AS title
           FROM nodes n
           LEFT JOIN docs d ON d.id = n.id
           LEFT JOIN containers c ON c.id = n.id
           WHERE n.id = ANY($1)`,
          [nodeIds]
        )
      : Promise.resolve({ rows: [] as NodeRow[] }),
    tableIds.length > 0
      ? pool.query<TableCatalogRow>(
          `SELECT t.id, t.name FROM public.table_catalog t WHERE t.id = ANY($1::text[])`,
          [tableIds]
        )
      : Promise.resolve({ rows: [] as TableCatalogRow[] }),
  ]);

  const foundMap = new Map<string, NodeRow>();
  for (const r of nodeResult.rows ?? []) {
    foundMap.set(r.id, r);
  }
  for (const r of tableResult.rows ?? []) {
    foundMap.set(r.id, { id: r.id, type: 'table', title: r.name, archived: false });
  }

  const verified = ids.map((id) => {
    const row = foundMap.get(id);
    if (!row) {
      return { id, exists: false };
    }
    return {
      id,
      exists: true,
      type: row.type,
      title: row.title,
      archived: row.archived === true,
    };
  });

  const foundCount = verified.filter((v) => v.exists).length;

  return {
    verified,
    summary: {
      requested: ids.length,
      found: foundCount,
      not_found: ids.length - foundCount,
    },
    note:
      foundCount === ids.length
        ? 'All IDs verified — safe to quote in a delivered message.'
        : 'Some IDs do NOT exist. Do not quote not-found IDs in any delivered message, doc, or memory.',
  };
}
