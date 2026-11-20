import { getDb } from '@snaglet/db';
import { visibleThreadRowSql } from '@snaglet/db/tables/threads/visibility';
import { formatSnippet, trimUntrustedToOneLine } from './formatters';
import { memoryScopeParams, memoryScopeSql, type MemorySearchScope } from './memoryScope';
import type { DocHit, MessageHit, SearchHit, SemanticRankedHit, SemanticSearchKind } from './types';

/**
 * `memoryScope` is the last gate on memory hits from every semantic channel
 * (vector, FTS, fuzzy titles, graph): a memory outside it is dropped.
 */
export async function hydrateSemanticHits(
  ranked: SemanticRankedHit[],
  memoryScope: MemorySearchScope | null = null
): Promise<SearchHit[]> {
  if (ranked.length === 0) return [];
  const byKind = new Map<SemanticSearchKind, string[]>();
  for (const hit of ranked) {
    const ids = byKind.get(hit.kind) ?? [];
    ids.push(hit.id);
    byKind.set(hit.kind, ids);
  }
  const scoreById = new Map(ranked.map((hit) => [hit.id, hit]));
  const hydrated = new Map<string, SearchHit>();
  const pool = getDb();

  await Promise.all(
    Array.from(byKind.entries()).map(async ([kind, ids]) => {
      if (kind === 'doc') {
        const { rows } = await pool.query<{
          id: string;
          title: string;
          content: string | null;
          updated_at: string;
        }>(
          `SELECT d.id, d.title, d.content, n.updated_at
             FROM public.docs d
             JOIN public.nodes n ON n.id = d.id
            WHERE d.id = ANY($1::text[])`,
          [ids]
        );
        for (const row of rows) {
          const rankedHit = scoreById.get(row.id);
          hydrated.set(row.id, {
            kind: 'doc',
            id: row.id,
            title: row.title,
            updatedAt: row.updated_at,
            rank: ranked.findIndex((hit) => hit.id === row.id) + 1,
            // Neutralize before truncating (see helpers.ts's
            // trimUntrustedToOneLine): row.content is attacker-reachable doc
            // content, and renderHit only neutralizes after this snippet is
            // already built, too late to fix a forged tag padded to
            // straddle this 220-char cutoff.
            snippet: trimUntrustedToOneLine(row.content ?? '', 220) || '(empty doc)',
            score: rankedHit?.score,
            channels: rankedHit?.channels,
          });
        }
      } else if (kind === 'message') {
        const { rows } = await pool.query<{
          id: string;
          thread_id: string;
          thread_title: string;
          role: string;
          agent_id: string | null;
          agent_name: string | null;
          user_id: string | null;
          user_name: string | null;
          content: string | null;
          created_at: string;
        }>(
          `SELECT m.id,
                  m.thread_id,
                  COALESCE(t.title, '(untitled thread)') AS thread_title,
                  m.role,
                  m.agent_id,
                  a.name AS agent_name,
                  m.user_id,
                  u.name AS user_name,
                  m.content,
                  m.created_at
             FROM public.messages m
             JOIN public.nodes n ON n.id = m.id
             JOIN public.threads t ON t.id = m.thread_id
             LEFT JOIN public.agents a ON a.id = m.agent_id
             LEFT JOIN public.users u ON u.id = m.user_id
            WHERE m.id = ANY($1::text[])
              -- Second layer behind the embedding gates: a vector for a
              -- message in a helper or DM thread never becomes a hit.
              AND ${visibleThreadRowSql('t')}`,
          [ids]
        );
        for (const row of rows) {
          const sender =
            row.agent_name ??
            row.user_name ??
            (row.role === 'user' ? (row.user_id == null ? 'user' : `user ${row.user_id}`) : null) ??
            row.agent_id ??
            row.role;
          const rankedHit = scoreById.get(row.id);
          hydrated.set(row.id, {
            kind: 'message',
            id: row.id,
            threadId: row.thread_id,
            threadTitle: row.thread_title,
            sender,
            sentAt: row.created_at,
            updatedAt: row.created_at,
            // Same neutralize-before-truncate ordering as the doc case above.
            snippet: trimUntrustedToOneLine(row.content ?? '', 220) || '(empty message)',
            score: rankedHit?.score,
            channels: rankedHit?.channels,
          });
        }
      } else if (kind === 'memory') {
        const { rows } = await pool.query<{
          id: string;
          memory_key: string | null;
          content: string | null;
          agent_id: string | null;
          source_thread_id: string | null;
          updated_at: string;
        }>(
          `SELECT mem.id, mem.memory_key, mem.content, mem.agent_id, mem.source_thread_id, n.updated_at
             FROM public.memories mem
             JOIN public.nodes n ON n.id = mem.id
            WHERE mem.id = ANY($1::text[])
              AND ${memoryScopeSql('mem', 2, 3)}`,
          [ids, ...memoryScopeParams(memoryScope)]
        );
        for (const row of rows) {
          hydrated.set(row.id, {
            kind: 'memory',
            id: row.id,
            key: row.memory_key,
            content: row.content,
            agentId: row.agent_id,
            sourceThreadId: row.source_thread_id,
            updatedAt: row.updated_at,
          });
        }
      } else if (kind === 'thread_summary') {
        const { rows } = await pool.query<{
          id: string;
          thread_id: string;
          thread_title: string;
          agent_id: string | null;
          summary_text: string | null;
          updated_at: string;
        }>(
          `SELECT ts.id,
                  ts.thread_id,
                  COALESCE(t.title, '(untitled thread)') AS thread_title,
                  ts.agent_id,
                  ts.summary_text,
                  n.updated_at
             FROM public.thread_summaries ts
             JOIN public.nodes n ON n.id = ts.id
             JOIN public.threads t ON t.id = ts.thread_id
            WHERE ts.id = ANY($1::text[])
              AND ${visibleThreadRowSql('t')}`,
          [ids]
        );
        for (const row of rows) {
          hydrated.set(row.id, {
            kind: 'thread_summary',
            id: row.id,
            threadId: row.thread_id,
            threadTitle: row.thread_title,
            agentId: row.agent_id,
            summaryText: row.summary_text,
            updatedAt: row.updated_at,
          });
        }
      } else if (kind === 'file') {
        const { rows } = await pool.query<{
          id: string;
          relative_path: string;
          content_hash: string;
          project_id: string;
          size_bytes: string | number;
          updated_at: string;
        }>(
          `SELECT f.id, f.relative_path, f.content_hash, f.project_id, f.size_bytes, n.updated_at
             FROM public.files f
             JOIN public.nodes n ON n.id = f.id
            WHERE f.id = ANY($1::text[])`,
          [ids]
        );
        // Embeddings are content-addressed: list every live path referencing
        // each hit's content so a shared file surfaces all its owners.
        const hashes = [...new Set(rows.map((row) => row.content_hash))];
        const pathsByHash = new Map<string, Array<{ projectId: string; relativePath: string }>>();
        if (hashes.length > 0) {
          const { rows: refRows } = await pool.query<{
            content_hash: string;
            project_id: string;
            relative_path: string;
          }>(
            `SELECT f.content_hash, f.project_id, f.relative_path
               FROM public.files f
               JOIN public.nodes n ON n.id = f.id AND n.archived = false
              WHERE f.content_hash = ANY($1::text[])
              ORDER BY f.project_id ASC, f.relative_path ASC`,
            [hashes]
          );
          for (const ref of refRows) {
            const list = pathsByHash.get(ref.content_hash) ?? [];
            list.push({ projectId: ref.project_id, relativePath: ref.relative_path });
            pathsByHash.set(ref.content_hash, list);
          }
        }
        for (const row of rows) {
          const rankedHit = scoreById.get(row.id);
          hydrated.set(row.id, {
            kind: 'file',
            id: row.id,
            relativePath: row.relative_path,
            projectId: row.project_id,
            sizeBytes: Number(row.size_bytes),
            updatedAt: row.updated_at,
            score: rankedHit?.score,
            channels: rankedHit?.channels,
            // Carry chunk match info through to the formatter so 'matched chunk #N · bytes M–K'
            // can render. Without these, the formatter's chunk line silently never appears.
            chunkIndex: rankedHit?.chunkIndex,
            chunkStart: rankedHit?.chunkStart,
            chunkEnd: rankedHit?.chunkEnd,
            paths: pathsByHash.get(row.content_hash),
          });
        }
      }
    })
  );

  return ranked.flatMap((hit) => {
    const row = hydrated.get(hit.id);
    return row ? [row] : [];
  });
}

export async function hydrateHybridDocHits(
  query: string,
  hits: Array<{ node_id: string; score: number; channels: ('fts' | 'vector')[] }>
): Promise<DocHit[]> {
  if (hits.length === 0) return [];

  const ids = hits.map((hit) => hit.node_id);
  const hitById = new Map(hits.map((hit) => [hit.node_id, hit]));
  const { rows } = await getDb().query<{
    id: string;
    title: string;
    updated_at: string;
    snippet: string | null;
  }>(
    `
      WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
      SELECT
        d.id,
        d.title,
        n.updated_at,
        ts_headline(
          'english',
          regexp_replace(d.content, '\\[([^\\]]+)\\]\\([^)]+\\)', '\\1', 'g'),
          q.tsq,
          'StartSel="**", StopSel="**", MaxFragments=2, FragmentDelimiter=" … ", MinWords=8, MaxWords=24, HighlightAll=FALSE'
        ) AS snippet
      FROM public.docs d
      JOIN public.nodes n ON n.id = d.id
      CROSS JOIN q
      WHERE d.id = ANY($2::text[])
    `,
    [query, ids]
  );

  const byId = new Map(rows.map((row) => [row.id, row]));
  return hits.flatMap((hit, index) => {
    const row = byId.get(hit.node_id);
    if (!row) return [];
    const search = hitById.get(hit.node_id);
    return [
      {
        kind: 'doc' as const,
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
        rank: index + 1,
        snippet: formatSnippet(row.snippet),
        score: search?.score,
        channels: search?.channels,
      },
    ];
  });
}

export async function hydrateHybridMessageHits(
  query: string,
  hits: Array<{ node_id: string; score: number; channels: ('fts' | 'vector')[] }>
): Promise<MessageHit[]> {
  if (hits.length === 0) return [];

  const ids = hits.map((hit) => hit.node_id);
  const hitById = new Map(hits.map((hit) => [hit.node_id, hit]));
  const { rows } = await getDb().query<{
    id: string;
    thread_id: string;
    thread_title: string;
    role: string;
    agent_id: string | null;
    agent_name: string | null;
    user_id: string | null;
    user_name: string | null;
    created_at: string;
    snippet: string | null;
  }>(
    `
      WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
      SELECT
        m.id,
        m.thread_id,
        COALESCE(t.title, '(untitled thread)') AS thread_title,
        m.role,
        m.agent_id,
        a.name AS agent_name,
        m.user_id,
        u.name AS user_name,
        m.created_at,
        ts_headline(
          'english',
          m.content,
          q.tsq,
          'StartSel="**", StopSel="**", MaxFragments=2, FragmentDelimiter=" … ", MinWords=8, MaxWords=24, HighlightAll=FALSE'
        ) AS snippet
      FROM public.messages m
      JOIN public.nodes n ON n.id = m.id
      JOIN public.threads t ON t.id = m.thread_id
      LEFT JOIN public.agents a ON a.id = m.agent_id
      LEFT JOIN public.users u ON u.id = m.user_id
      CROSS JOIN q
      WHERE m.id = ANY($2::text[])
        AND ${visibleThreadRowSql('t')}
    `,
    [query, ids]
  );

  const byId = new Map(rows.map((row) => [row.id, row]));
  return hits.flatMap((hit) => {
    const row = byId.get(hit.node_id);
    if (!row) return [];
    const search = hitById.get(hit.node_id);
    const sender =
      row.agent_name ??
      row.user_name ??
      (row.role === 'user' ? (row.user_id == null ? 'user' : `user ${row.user_id}`) : null) ??
      row.agent_id ??
      row.role;
    return [
      {
        kind: 'message' as const,
        id: row.id,
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        sender,
        sentAt: row.created_at,
        updatedAt: row.created_at,
        snippet: formatSnippet(row.snippet),
        score: search?.score,
        channels: search?.channels,
      },
    ];
  });
}
