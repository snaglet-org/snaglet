import { getDb } from '@snaglet/db';

export type DynamicContentKind = 'doc' | 'message' | 'memory' | 'container' | 'thread_summary';

interface ContentRow {
  id: string;
  type: string;
  content: string | null;
}

/** Resolve the current value of a content-bearing Snaglet node at execution time. */
export async function resolveDynamicContent(nodeId: string): Promise<{
  id: string;
  kind: DynamicContentKind;
  content: string;
}> {
  const id = nodeId.trim();
  if (!id) throw new Error('nodeId is required');
  const { rows } = await getDb().query<ContentRow>(
    `SELECT n.id, n.type::text AS type,
            CASE n.type::text
              WHEN 'doc' THEN d.content
              WHEN 'message' THEN msg.content
              WHEN 'memory' THEN mem.content
              WHEN 'container' THEN c.name
              WHEN 'thread_summary' THEN ts.summary_text
              ELSE NULL
            END AS content
       FROM public.nodes n
       LEFT JOIN public.docs d ON d.id = n.id AND n.type::text = 'doc'
       LEFT JOIN public.messages msg ON msg.id = n.id AND n.type::text = 'message'
       LEFT JOIN public.memories mem ON mem.id = n.id AND n.type::text = 'memory'
       LEFT JOIN public.containers c ON c.id = n.id AND n.type::text = 'container'
       LEFT JOIN public.thread_summaries ts
         ON ts.id = n.id AND n.type::text = 'thread_summary'
      WHERE n.id = $1 AND n.archived = false`,
    [id]
  );
  const row = rows[0];
  if (!row) throw new Error(`Node not found: ${id}`);
  if (
    row.type !== 'doc' &&
    row.type !== 'message' &&
    row.type !== 'memory' &&
    row.type !== 'container' &&
    row.type !== 'thread_summary'
  ) {
    throw new Error(
      `snaglet.parseContent does not support ${row.type} nodes; expected doc, message, memory, container, or thread_summary`
    );
  }
  return { id: row.id, kind: row.type, content: row.content ?? '' };
}
