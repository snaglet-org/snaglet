import { getDb } from '@snaglet/db';
import {
  SEMANTIC_SEARCH_KINDS,
  type SearchChannel,
  type SemanticRankedHit,
  type SemanticSearchKind,
} from './types';

export function collectDescendants(
  rootId: string,
  childrenByParent: Map<string, string[]>
): string[] {
  const out: string[] = [];
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const kids = childrenByParent.get(id);
    if (kids) queue.push(...kids);
  }
  return out;
}

export async function collectThreadConnectedIds(threadId: string): Promise<Set<string>> {
  const connected = new Set<string>([threadId]);
  const pool = getDb();
  const [{ rows: linkRows }, { rows: summaryRows }, { rows: messageRows }] = await Promise.all([
    pool.query<{ source_id: string; target_id: string }>(
      `SELECT l.source_id, l.target_id
         FROM public.links l
         JOIN public.nodes sn ON sn.id = l.source_id
         JOIN public.nodes tn ON tn.id = l.target_id
        WHERE (sn.type::text = 'thread' AND l.source_id = $1::text)
           OR (tn.type::text = 'thread' AND l.target_id = $1::text)
        LIMIT 500`,
      [threadId]
    ),
    pool.query<{ id: string }>(
      `SELECT id::text AS id FROM public.thread_summaries WHERE thread_id = $1::text LIMIT 100`,
      [threadId]
    ),
    pool.query<{ id: string }>(
      `SELECT id::text AS id FROM public.messages WHERE thread_id = $1::text LIMIT 500`,
      [threadId]
    ),
  ]);
  for (const row of linkRows) {
    connected.add(row.source_id);
    connected.add(row.target_id);
  }
  for (const row of summaryRows) connected.add(row.id);
  for (const row of messageRows) connected.add(row.id);
  return connected;
}

export async function graphWalkSemanticHits(
  seeds: SemanticRankedHit[],
  remainingLimit: number,
  includeArchived = false,
  includeSupersededThreadSummaries = false
): Promise<SemanticRankedHit[]> {
  if (remainingLimit <= 0 || seeds.length === 0) return [];
  const seedIds = seeds.map((seed) => seed.id);
  const seedById = new Map(seeds.map((seed) => [seed.id, seed]));
  const { rows } = await getDb().query<{
    source_id: string;
    target_id: string;
    source_type: string;
    target_type: string;
  }>(
    `SELECT l.source_id,
            l.target_id,
            sn.type::text AS source_type,
            tn.type::text AS target_type
       FROM public.links l
       JOIN public.nodes sn ON sn.id = l.source_id
       JOIN public.nodes tn ON tn.id = l.target_id
       LEFT JOIN public.thread_summaries sts
         ON sts.id = l.source_id AND sn.type = 'thread_summary'
       LEFT JOIN public.nodes stn ON stn.id = sts.thread_id AND sn.type = 'thread_summary'
       LEFT JOIN public.thread_summaries tts
         ON tts.id = l.target_id AND tn.type = 'thread_summary'
       LEFT JOIN public.nodes ttn ON ttn.id = tts.thread_id AND tn.type = 'thread_summary'
      WHERE (l.source_id = ANY($1::text[]) OR l.target_id = ANY($1::text[]))
        AND (
          $2::boolean
          OR (
            sn.archived = false
            AND tn.archived = false
            AND (sn.type <> 'thread_summary' OR stn.archived = false)
            AND (tn.type <> 'thread_summary' OR ttn.archived = false)
          )
        )
        AND (
          $3::boolean
          OR (
            (sn.type <> 'thread_summary' OR sts.is_current = true)
            AND (tn.type <> 'thread_summary' OR tts.is_current = true)
          )
        )
      LIMIT 100`,
    [seedIds, includeArchived, includeSupersededThreadSummaries]
  );

  const seen = new Set(seedIds);
  const out: SemanticRankedHit[] = [];
  for (const row of rows) {
    const seedId = seedById.has(row.source_id) ? row.source_id : row.target_id;
    const linkedId = seedId === row.source_id ? row.target_id : row.source_id;
    const linkedType = seedId === row.source_id ? row.target_type : row.source_type;
    if (seen.has(linkedId) || !(SEMANTIC_SEARCH_KINDS as ReadonlySet<string>).has(linkedType)) {
      continue;
    }
    seen.add(linkedId);
    const seed = seedById.get(seedId);
    out.push({
      id: linkedId,
      kind: linkedType as SemanticSearchKind,
      score: (seed?.score ?? 0) * 0.6,
      channels: [],
    });
    if (out.length >= remainingLimit) break;
  }
  return out;
}

/**
 * Graph proximity as a first-class RRF channel.
 *
 * Unlike `graphWalkSemanticHits` (post-fusion tail-backfill), this produces a
 * ranked list of link-proximate neighbors fused ALONGSIDE vector and FTS via
 * `fuseRRF([vector, fts, graph])`. A node that is both semantically relevant AND
 * link-proximate appears in two channels, so RRF lifts it. RRF (k=60) bounds
 * this so links can never dominate. Seeds should be the pre-fusion vector+FTS
 * union (top-N); 1-hop only. Ranking is by graph score desc.
 */
export async function graphChannelHits(
  seeds: SemanticRankedHit[],
  limit: number,
  hubDamping = false,
  excludeHubKinds = false,
  includeArchived = false,
  includeSupersededThreadSummaries = false
): Promise<SemanticRankedHit[]> {
  if (limit <= 0 || seeds.length === 0) return [];
  // Rank-level suppression: removes hub kinds from channel membership entirely
  // so they never receive a rank and RRF cannot reinforce them.
  // thread_summary is the primary structural hub (linked to every node in the thread).
  const HUB_KINDS: ReadonlySet<string> = new Set(['thread_summary']);
  const seedIds = seeds.map((seed) => seed.id);
  const seedById = new Map(seeds.map((seed) => [seed.id, seed]));
  const { rows } = await getDb().query<{
    source_id: string;
    target_id: string;
    source_type: string;
    target_type: string;
  }>(
    `SELECT l.source_id,
            l.target_id,
            sn.type::text AS source_type,
            tn.type::text AS target_type
       FROM public.links l
       JOIN public.nodes sn ON sn.id = l.source_id
       JOIN public.nodes tn ON tn.id = l.target_id
       LEFT JOIN public.thread_summaries sts
         ON sts.id = l.source_id AND sn.type = 'thread_summary'
       LEFT JOIN public.nodes stn ON stn.id = sts.thread_id AND sn.type = 'thread_summary'
       LEFT JOIN public.thread_summaries tts
         ON tts.id = l.target_id AND tn.type = 'thread_summary'
       LEFT JOIN public.nodes ttn ON ttn.id = tts.thread_id AND tn.type = 'thread_summary'
      WHERE (l.source_id = ANY($1::text[]) OR l.target_id = ANY($1::text[]))
        AND (
          $2::boolean
          OR (
            sn.archived = false
            AND tn.archived = false
            AND (sn.type <> 'thread_summary' OR stn.archived = false)
            AND (tn.type <> 'thread_summary' OR ttn.archived = false)
          )
        )
        AND (
          $3::boolean
          OR (
            (sn.type <> 'thread_summary' OR sts.is_current = true)
            AND (tn.type <> 'thread_summary' OR tts.is_current = true)
          )
        )
      LIMIT 200`,
    [seedIds, includeArchived, includeSupersededThreadSummaries]
  );

  // Keep the single strongest provenance per neighbor (a node may be reachable
  // from multiple seeds; we take the max-scoring seed so the channel rank is stable).
  const bestByNeighbor = new Map<string, { kind: SemanticSearchKind; score: number }>();
  for (const row of rows) {
    const seedId = seedById.has(row.source_id) ? row.source_id : row.target_id;
    const linkedId = seedId === row.source_id ? row.target_id : row.source_id;
    const linkedType = seedId === row.source_id ? row.target_type : row.source_type;
    if (seedById.has(linkedId)) continue; // a seed's own membership lives in vector/fts
    if (!(SEMANTIC_SEARCH_KINDS as ReadonlySet<string>).has(linkedType)) continue;
    if (excludeHubKinds && HUB_KINDS.has(linkedType)) continue; // drop structural hubs from channel membership
    const seed = seedById.get(seedId);
    const score = (seed?.score ?? 0) * 0.6;
    const prev = bestByNeighbor.get(linkedId);
    if (!prev || score > prev.score) {
      bestByNeighbor.set(linkedId, { kind: linkedType as SemanticSearchKind, score });
    }
  }

  // Hub-damping: attenuates a neighbor's score by inverse-log of its total link
  // degree. A degree-1 leaf is untouched (ln(1)=0 → factor 1.0); a degree-50
  // hub is suppressed to ~0.20x. One COUNT query over the candidate set.
  if (hubDamping && bestByNeighbor.size > 0) {
    const neighborIds = Array.from(bestByNeighbor.keys());
    const { rows: degreeRows } = await getDb().query<{ node_id: string; degree: string }>(
      `SELECT node_id, COUNT(*)::text AS degree
         FROM (
           SELECT source_id AS node_id FROM public.links WHERE source_id = ANY($1::text[])
           UNION ALL
           SELECT target_id AS node_id FROM public.links WHERE target_id = ANY($1::text[])
         ) edges
        GROUP BY node_id`,
      [neighborIds]
    );
    const degreeById = new Map(degreeRows.map((r) => [r.node_id, Number(r.degree)]));
    for (const [id, entry] of bestByNeighbor) {
      const degree = degreeById.get(id) ?? 1;
      // ln(1)=0 -> no penalty for leaf neighbors; grows with degree for hubs.
      const dampingFactor = 1 / (1 + Math.log(Math.max(1, degree)));
      entry.score *= dampingFactor;
    }
  }

  return Array.from(bestByNeighbor.entries())
    .map(([id, { kind, score }]) => ({ id, kind, score, channels: ['graph'] as SearchChannel[] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
