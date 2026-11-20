import { getDb } from '@snaglet/db/db';
import { EMBEDDABLE_MESSAGE_SQL } from './messageEligibility';

/**
 * Idempotent startup cleanup: only derived vectors joined to ineligible
 * messages (injected rows, and anything in a subagent helper thread).
 */
export async function removeAllIneligibleMessageEmbeddings(): Promise<number> {
  const result = await getDb().query(`
    DELETE FROM public.embeddings e USING public.messages m
    WHERE e.node_id = m.id AND NOT (${EMBEDDABLE_MESSAGE_SQL})
  `);
  return result.rowCount ?? 0;
}

/** Read-only inventory. Explicit cleanup accepts only reviewed message IDs. */
export async function auditInjectedMessageEmbeddings(): Promise<
  Array<{ node_id: string; chunks: number }>
> {
  const { rows } = await getDb().query<{ node_id: string; chunks: number }>(`
    SELECT e.node_id, COUNT(*)::int AS chunks
    FROM public.embeddings e JOIN public.messages m ON m.id = e.node_id
    WHERE NOT (${EMBEDDABLE_MESSAGE_SQL})
    GROUP BY e.node_id ORDER BY e.node_id
  `);
  return rows;
}

/** Rechecks eligibility at deletion time; never deletes messages or other node kinds. */
export async function removeInjectedMessageEmbeddings(nodeIds: string[]): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const result = await getDb().query(
    `
    DELETE FROM public.embeddings e USING public.messages m
    WHERE e.node_id = m.id AND e.node_id = ANY($1::text[])
      AND NOT (${EMBEDDABLE_MESSAGE_SQL})
  `,
    [nodeIds]
  );
  return result.rowCount ?? 0;
}
