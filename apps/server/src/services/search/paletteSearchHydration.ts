import { helperAgentExclusionSql } from '@snaglet/db/tables/agents/visibility';
import { visibleThreadRowSql } from '@snaglet/db/tables/threads/visibility';
import { getDb } from '@snaglet/db';
import type { PaletteNodeKind } from '@snaglet/shared/constants/nodeKinds';
import { canonicalToolRows } from '@server/services/ToolService/lib/canonicalToolRows';
import type { NodeSearchHit } from './nodeSearch';
import type { PaletteSearchHit } from './paletteSearchSupport';

export function paletteHit(
  kind: PaletteNodeKind,
  nodeId: string,
  payload: Record<string, unknown>,
  base?: Pick<NodeSearchHit, 'score' | 'channels' | 'vectorSimilarity'>
): PaletteSearchHit {
  return {
    node_id: nodeId,
    kind,
    score: base?.score ?? 0,
    channels: base?.channels ?? [],
    vectorSimilarity: base?.vectorSimilarity,
    payload,
  };
}

/**
 * Load each hit's payload; hits whose row is gone, archived or otherwise not a
 * palette item drop out. The lanes already leave out subagent helper threads,
 * their messages and summaries, and helper agents; hydration refuses them too,
 * so no lane can surface one.
 */
export async function hydratePaletteHits(
  kind: PaletteNodeKind,
  hits: PaletteSearchHit[]
): Promise<PaletteSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((hit) => hit.node_id);
  const pool = getDb();

  switch (kind) {
    case 'container': {
      const { rows } = await pool.query<{
        id: string;
        name: string;
        container_id: string | null;
        sort_order: number;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT c.id, c.name, n.container_id, n.sort_order, n.created_at, n.updated_at
           FROM public.containers c
           JOIN public.nodes n ON n.id = c.id
          WHERE c.id = ANY($1::text[]) AND n.archived = false`,
        [ids]
      );
      const byId = new Map(
        rows.map((row) => [
          row.id,
          {
            name: row.name,
            containerId: row.container_id,
            sortOrder: row.sort_order,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ])
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
    case 'doc': {
      const { rows } = await pool.query<{
        id: string;
        title: string;
        container_id: string | null;
        sort_order: number;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT d.id, d.title, n.container_id, n.sort_order, n.created_at, n.updated_at
           FROM public.docs d
           JOIN public.nodes n ON n.id = d.id
          WHERE d.id = ANY($1::text[]) AND n.archived = false`,
        [ids]
      );
      const byId = new Map(
        rows.map((row) => [
          row.id,
          {
            title: row.title,
            containerId: row.container_id,
            sortOrder: row.sort_order,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ])
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
    case 'thread': {
      const { rows } = await pool.query<{
        id: string;
        title: string | null;
        project_id: string | null;
        sort_order: number;
        last_message_at: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT t.id, t.title, n.project_id, n.sort_order, t.last_message_at,
                n.created_at, n.updated_at
           FROM public.threads t
           JOIN public.nodes n ON n.id = t.id
          WHERE t.id = ANY($1::text[]) AND n.archived = false AND ${visibleThreadRowSql('t')}`,
        [ids]
      );
      const byId = new Map(
        rows.map((row) => [
          row.id,
          {
            title: row.title,
            projectId: row.project_id,
            // Deprecated alias of projectId, read by the palette until it
            // moves to projectId.
            containerId: row.project_id,
            sortOrder: row.sort_order,
            lastMessageAt: row.last_message_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ])
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
    case 'message': {
      const { rows } = await pool.query<{
        id: string;
        content: string;
        role: string;
        thread_id: string;
        thread_title: string | null;
        agent_id: string | null;
        user_id: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT m.id, m.content, m.role, m.thread_id, t.title AS thread_title,
                m.agent_id, m.user_id::text AS user_id, n.created_at, n.updated_at
           FROM public.messages m
           JOIN public.nodes n ON n.id = m.id
           LEFT JOIN public.threads t ON t.id = m.thread_id
          WHERE m.id = ANY($1::text[]) AND n.archived = false AND ${visibleThreadRowSql('t')}`,
        [ids]
      );
      const byId = new Map(
        rows.map((row) => [
          row.id,
          {
            content: row.content,
            title: row.content.slice(0, 120),
            role: row.role,
            threadId: row.thread_id,
            threadTitle: row.thread_title,
            agentId: row.agent_id,
            userId: row.user_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ])
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
    case 'image': {
      const { rows } = await pool.query<{
        id: string;
        alt_text: string | null;
        description: string | null;
        tags: string[];
        metadata: Record<string, unknown> | null;
        container_id: string | null;
        sort_order: number;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT i.id, i.alt_text, i.description, i.tags, i.metadata, n.container_id, n.sort_order,
                n.created_at, n.updated_at
           FROM public.images i
           JOIN public.nodes n ON n.id = i.id
          WHERE i.id = ANY($1::text[]) AND n.archived = false`,
        [ids]
      );
      const byId = new Map(
        rows.map((row) => {
          const meta = row.metadata ?? {};
          return [
            row.id,
            {
              name: row.alt_text ?? '',
              description: row.description,
              tags: row.tags,
              mimeType:
                typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream',
              sizeBytes: typeof meta.sizeBytes === 'number' ? meta.sizeBytes : 0,
              containerId: row.container_id,
              sortOrder: row.sort_order,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            },
          ];
        })
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
    case 'memory': {
      const { rows } = await pool.query<{
        id: string;
        memory_key: string | null;
        content: string;
        agent_id: string;
        source_thread_id: string | null;
        source_thread_title: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT m.id, m.memory_key, m.content, m.agent_id, m.source_thread_id,
                t.title AS source_thread_title, n.created_at, n.updated_at
           FROM public.memories m
           JOIN public.nodes n ON n.id = m.id
           LEFT JOIN public.threads t ON t.id = m.source_thread_id
          WHERE m.id = ANY($1::text[]) AND n.archived = false`,
        [ids]
      );
      const byId = new Map(
        rows.map((row) => [
          row.id,
          {
            title: row.memory_key ?? 'Memory',
            key: row.memory_key,
            content: row.content,
            agentId: row.agent_id,
            sourceThreadId: row.source_thread_id,
            sourceThreadTitle: row.source_thread_title,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ])
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
    case 'thread_summary': {
      const { rows } = await pool.query<{
        id: string;
        summary_text: string;
        thread_id: string;
        thread_title: string | null;
        agent_id: string | null;
        messages_covered: number;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT ts.id, ts.summary_text, ts.thread_id, t.title AS thread_title,
                ts.agent_id, ts.messages_covered, n.created_at, n.updated_at
           FROM public.thread_summaries ts
           JOIN public.nodes n ON n.id = ts.id
           LEFT JOIN public.threads t ON t.id = ts.thread_id
          WHERE ts.id = ANY($1::text[]) AND n.archived = false AND ${visibleThreadRowSql('t')}`,
        [ids]
      );
      const byId = new Map(
        rows.map((row) => [
          row.id,
          {
            title: 'Thread summary',
            summaryText: row.summary_text,
            threadId: row.thread_id,
            threadTitle: row.thread_title,
            agentId: row.agent_id,
            messagesCovered: row.messages_covered,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ])
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
    case 'tool': {
      const { rows } = await pool.query<{
        id: string;
        name: string;
        description: string;
        type: string;
        source: string | null;
        category_path: string;
        provider_id: string | null;
        tier: string;
        enabled: boolean;
        sort_order: number;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT t.id, t.name, t.description, t.type, t.source, t.category_path, t.provider_id, t.tier,
                t.enabled, t.sort_order, t.created_at, t.updated_at
           FROM public.tools t
           JOIN public.nodes n ON n.id = t.id
          WHERE t.id = ANY($1::text[]) AND n.archived = false`,
        [ids]
      );
      // A merged tool's alias ids stay callable but are never offered: their
      // non-canonical rows drop out (canonicalToolRows).
      const byId = new Map(
        canonicalToolRows(rows).map((row) => [
          row.id,
          {
            name: row.name,
            title: row.name,
            description: row.description,
            type: row.type,
            source: row.source,
            categoryPath: row.category_path,
            providerId: row.provider_id,
            tier: row.tier,
            enabled: row.enabled,
            sortOrder: row.sort_order,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ])
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
    case 'agent': {
      const { rows } = await pool.query<{
        id: string;
        name: string;
        role: string | null;
        avatar_url: string | null;
        created_at: string;
        updated_at: string;
      }>(
        // Agents are actors, not nodes — read timestamps from the agents
        // table; no nodes JOIN / archived filter. Subagent helpers never hydrate.
        `SELECT a.id, a.name, a.role, a.avatar_url, a.created_at, a.updated_at
           FROM public.agents a
          WHERE a.id = ANY($1::text[]) AND ${helperAgentExclusionSql('a')}`,
        [ids]
      );
      const byId = new Map(
        rows.map((row) => [
          row.id,
          {
            // The tree dropdown labels rows from `payload.name || payload.title`,
            // so populate both and surface role as the subtitle.
            name: row.name,
            title: row.name,
            role: row.role,
            avatarUrl: row.avatar_url,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ])
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
    case 'table': {
      // Catalog rows, not nodes. Only display metadata leaves the server: the
      // physical `table_name` and the table's rows are never part of a hit.
      const { rows } = await pool.query<{
        id: string;
        name: string;
        origin: string;
        created_at: string;
      }>(
        `SELECT t.id, t.name, t.origin, t.created_at
           FROM public.table_catalog t
          WHERE t.id = ANY($1::text[])`,
        [ids]
      );
      const byId = new Map(
        rows.map((row) => [
          row.id,
          {
            name: row.name,
            title: row.name,
            origin: row.origin,
            createdAt: row.created_at,
          },
        ])
      );
      return hits.flatMap((hit) => {
        const payload = byId.get(hit.node_id);
        return payload ? [paletteHit(kind, hit.node_id, payload, hit)] : [];
      });
    }
  }
}
