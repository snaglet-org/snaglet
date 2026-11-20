import { fuseRRF, type RankedCandidate } from '@server/services/search/fuseRRF';
import type { SearchChannel, SemanticRankedHit, SemanticSearchKind } from './types';

export function rankSemanticCandidates(args: {
  channels: RankedCandidate[][];
  kindById: Map<string, SemanticSearchKind>;
  query: string;
  limit: number;
}): SemanticRankedHit[] {
  const fused = fuseRRF(args.channels, { query: args.query, limit: args.limit });
  return fused.flatMap((hit) => {
    const kind = args.kindById.get(hit.id);
    if (!kind) return [];
    return [
      {
        id: hit.id,
        kind,
        score: hit.score,
        channels: hit.channels.filter(
          (channel): channel is SearchChannel =>
            channel === 'fts' || channel === 'vector' || channel === 'graph' || channel === 'fuzzy'
        ),
      },
    ];
  });
}
