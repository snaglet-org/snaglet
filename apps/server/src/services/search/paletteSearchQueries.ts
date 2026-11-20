import { helperAgentExclusionSql } from '@snaglet/db/tables/agents/visibility';
import {
  helperThreadContentExclusionSql,
  helperThreadExclusionSql,
} from '@snaglet/db/tables/threads/visibility';
import { getDb } from '@snaglet/db';
import {
  AGENT_ID_PREFIX,
  idPrefixAlternation,
  LEGACY_ID_PREFIX,
  NODE_KIND,
  PALETTE_NODE_KINDS,
  type PaletteNodeKind,
} from '@snaglet/shared/constants/nodeKinds';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants';
import { isTableCatalogId } from '@snaglet/shared/types/tables';
import { hydratePaletteHits, paletteHit } from './paletteSearchHydration';
import type { NodeSearchPaletteKind, PaletteSearchHit } from './paletteSearchSupport';

// Anything a user might paste as an id: live kinds, the agent actor prefix,
// and the older prefixes some rows still carry. `thread_summary` must come
// before `thread` only in unanchored patterns; here the trailing `-` anchors.
const NODE_ID_RE = new RegExp(
  `^(${idPrefixAlternation([
    NODE_KIND.DOC,
    NODE_KIND.THREAD,
    NODE_KIND.MESSAGE,
    NODE_KIND.CONTAINER,
    LEGACY_ID_PREFIX.PROJECT,
    NODE_KIND.MEMORY,
    NODE_KIND.THREAD_SUMMARY,
    NODE_KIND.TOOL,
    AGENT_ID_PREFIX,
  ])})-`,
  'i'
);

/** Make `%`, `_` and backslash literal inside a LIKE pattern escaped with `\`. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function searchPaletteOnlyKind(args: {
  query: string;
  kind: Exclude<PaletteNodeKind, NodeSearchPaletteKind>;
  limit: number;
}): Promise<PaletteSearchHit[]> {
  const query = args.query.trim();
  if (!query || args.limit < 1) return [];
  const limit = Math.max(1, Math.floor(args.limit));
  const pool = getDb();
  const commonParams = [query, limit];
  let rows: { id: string; score: number }[];

  switch (args.kind) {
    case 'memory': {
      ({ rows } = await pool.query<{ id: string; score: number }>(
        `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
         SELECT m.id,
                ts_rank_cd('{0.1, 0.2, 0.4, 1.0}'::float4[], m.search_text, q.tsq) AS score
           FROM public.memories m
           JOIN public.nodes n ON n.id = m.id AND n.archived = false
           CROSS JOIN q
          WHERE m.search_text @@ q.tsq
            -- A proposal waiting for approval is not a memory yet.
            AND m.status <> 'proposed'
          ORDER BY score DESC, m.id ASC
          LIMIT $2`,
        commonParams
      ));
      break;
    }
    case 'thread_summary': {
      ({ rows } = await pool.query<{ id: string; score: number }>(
        `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
         SELECT ts.id,
                ts_rank_cd('{0.1, 0.2, 0.4, 1.0}'::float4[], ts.search_text, q.tsq) AS score
           FROM public.thread_summaries ts
           JOIN public.nodes n ON n.id = ts.id AND n.archived = false
           CROSS JOIN q
          WHERE ts.search_text @@ q.tsq
            AND ${helperThreadExclusionSql('ts.thread_id')}
          ORDER BY score DESC, ts.id ASC
          LIMIT $2`,
        commonParams
      ));
      break;
    }
    case 'agent': {
      // Agents are short rows (name + role), so a plain ILIKE prefix
      // search is more forgiving than FTS at very short queries
      // (`patty`, `clio`). Rank by name-prefix > role-prefix > contains.
      // Agents are actors, not nodes — query the agents table directly;
      // no nodes JOIN. Archived agents are excluded from palette search the
      // same way archived nodes are (n.archived = false above), via the agents'
      // own archived column. Ghost is the system attribution actor and is
      // excluded from the palette entirely (a.id <> $3), and so are subagent
      // helpers.
      ({ rows } = await pool.query<{ id: string; score: number }>(
        `SELECT a.id,
                CASE
                  WHEN LOWER(a.name) = LOWER($1) THEN 1.0
                  WHEN LOWER(a.name) LIKE LOWER($1 || '%') THEN 0.9
                  WHEN LOWER(a.role) LIKE LOWER($1 || '%') THEN 0.7
                  WHEN LOWER(a.name) LIKE '%' || LOWER($1) || '%' THEN 0.6
                  WHEN LOWER(a.role) LIKE '%' || LOWER($1) || '%' THEN 0.4
                  ELSE 0.0
                END AS score
           FROM public.agents a
          WHERE (LOWER(a.name) LIKE '%' || LOWER($1) || '%'
             OR LOWER(COALESCE(a.role, '')) LIKE '%' || LOWER($1) || '%')
            AND a.archived = false
            AND a.id <> $3
            AND ${helperAgentExclusionSql('a')}
          ORDER BY score DESC, a.id ASC
          LIMIT $2`,
        [...commonParams, GHOST_AGENT_ID]
      ));
      break;
    }
    case 'image': {
      // The binary body is not searchable. Keep exact/name evidence strongest,
      // then match the same human-authored description + tag metadata as the
      // agent workspace_search keyword lane.
      ({ rows } = await pool.query<{ id: string; score: number }>(
        `SELECT i.id,
                CASE
                  WHEN LOWER(COALESCE(i.alt_text, '')) = LOWER($1) THEN 1.0
                  WHEN LOWER(COALESCE(i.alt_text, '')) LIKE LOWER($1 || '%') THEN 0.8
                  WHEN LOWER(COALESCE(i.alt_text, '')) LIKE '%' || LOWER($1) || '%' THEN 0.5
                  WHEN EXISTS (
                    SELECT 1 FROM unnest(i.tags) AS tag
                    WHERE LOWER(tag) = LOWER($1)
                  ) THEN 0.45
                  WHEN LOWER(COALESCE(i.description, '')) LIKE '%' || LOWER($1) || '%' THEN 0.35
                  WHEN LOWER(COALESCE(array_to_string(i.tags, ' '), '')) LIKE '%' || LOWER($1) || '%' THEN 0.3
                  ELSE 0.0
                END AS score
           FROM public.images i
           JOIN public.nodes n ON n.id = i.id AND n.archived = false
          WHERE LOWER(COALESCE(i.alt_text, '')) LIKE '%' || LOWER($1) || '%'
             OR LOWER(COALESCE(i.description, '')) LIKE '%' || LOWER($1) || '%'
             OR LOWER(COALESCE(array_to_string(i.tags, ' '), '')) LIKE '%' || LOWER($1) || '%'
          ORDER BY score DESC, i.id ASC
          LIMIT $2`,
        commonParams
      ));
      break;
    }
    case 'table': {
      // Database tables are catalog rows, not nodes: match the display name
      // only. The physical `table_name` and row contents are never a search
      // surface. Display names may contain `_`, so wildcards are escaped.
      ({ rows } = await pool.query<{ id: string; score: number }>(
        `SELECT t.id,
                (CASE
                  WHEN lower(t.name) = lower($1) THEN 1.0
                  WHEN t.name ILIKE ($3::text || '%') ESCAPE '\\' THEN 0.9
                  ELSE 0.6
                END)::float8 AS score
           FROM public.table_catalog t
          WHERE t.state = 'active' AND t.origin = 'custom' AND t.name ILIKE ('%' || $3::text || '%') ESCAPE '\\'
          ORDER BY score DESC, lower(t.name) ASC, t.id ASC
          LIMIT $2`,
        [...commonParams, escapeLikePattern(query)]
      ));
      break;
    }
  }

  return rows.map((row) =>
    paletteHit(args.kind, row.id, {}, { score: row.score, channels: ['fts'] })
  );
}

export async function browseKind(
  kind: PaletteNodeKind,
  limit: number
): Promise<PaletteSearchHit[]> {
  // 'agent' is an actor result kind, not a node kind: browse the agents
  // table, not public.nodes. Archived agents are excluded, like archived
  // nodes on the node-kind browse path.
  if (kind === 'agent') {
    const { rows } = await getDb().query<{ id: string }>(
      `SELECT a.id FROM public.agents a
        WHERE a.archived = false
          AND a.id <> $2
          AND ${helperAgentExclusionSql('a')}
        ORDER BY a.created_at DESC, a.id ASC
        LIMIT $1`,
      [limit, GHOST_AGENT_ID]
    );
    return hydratePaletteHits(
      kind,
      rows.map((row) => paletteHit(kind, row.id, {}))
    );
  }
  // Tables live in `public.table_catalog`, not public.nodes. The browse is
  // capped at the per-kind limit and the builtins alone exceed the default,
  // so the user's own tables lead, then name order.
  if (kind === 'table') {
    const { rows } = await getDb().query<{ id: string }>(
      `SELECT t.id FROM public.table_catalog t
        WHERE t.state = 'active'
        ORDER BY (t.origin = 'custom') DESC, lower(t.name) ASC, t.id ASC
        LIMIT $1`,
      [limit]
    );
    return hydratePaletteHits(
      kind,
      rows.map((row) => paletteHit(kind, row.id, {}))
    );
  }
  // Subagent helper threads, and their messages and summaries, are never
  // browsed.
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT n.id
       FROM public.nodes n
      WHERE n.type = $1
        AND n.archived = false
        AND ${helperThreadContentExclusionSql('n.id')}
      ORDER BY n.sort_order ASC, n.updated_at DESC, n.id ASC
      LIMIT $2`,
    [kind, limit]
  );
  return hydratePaletteHits(
    kind,
    rows.map((row) => paletteHit(kind, row.id, {}))
  );
}

export async function resolveExactId(
  query: string
): Promise<{ id: string; kind: PaletteNodeKind } | null> {
  if (isTableCatalogId(query)) {
    const { rows } = await getDb().query<{ id: string }>(
      `SELECT t.id FROM public.table_catalog t WHERE t.id = $1 AND t.state = 'active'`,
      [query]
    );
    const row = rows[0];
    return row ? { id: row.id, kind: 'table' } : null;
  }
  if (!NODE_ID_RE.test(query)) return null;
  // A subagent helper thread (or a message or summary in one) is not a
  // palette result even by exact id; it opens through its parent thread.
  const { rows } = await getDb().query<{ id: string; type: string }>(
    `SELECT n.id, n.type::text AS type
       FROM public.nodes n
      WHERE n.id = $1
        AND n.archived = false
        AND ${helperThreadContentExclusionSql('n.id')}
      LIMIT 1`,
    [query]
  );
  const row = rows[0];
  if (!row || !(PALETTE_NODE_KINDS as readonly string[]).includes(row.type)) return null;
  return { id: row.id, kind: row.type as PaletteNodeKind };
}
