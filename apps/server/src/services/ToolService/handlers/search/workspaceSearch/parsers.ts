import { clamp } from '@snaglet/shared/utils';
import {
  parseEnumList,
  parseEnumValue,
  parseIdList,
  parseOptionalNonEmptyString,
} from '@server/utils/searchParams';
import {
  DEFAULT_SEARCH_KINDS,
  DETAIL_LEVELS,
  SEARCHABLE_KINDS,
  SEMANTIC_SEARCH_KINDS,
  type DetailLevel,
  type SearchableKind,
  type SemanticSearchKind,
} from './types';

export function parseSearchKinds(input: unknown): SearchableKind[] {
  return parseEnumList(input, SEARCHABLE_KINDS, DEFAULT_SEARCH_KINDS);
}

export function parseDetail(input: unknown): DetailLevel {
  return parseEnumValue(input, DETAIL_LEVELS, 'compact');
}

export function parseIds(input: unknown): string[] {
  return parseIdList(input, 20);
}

export function parseGraphDepth(input: unknown): number {
  // Default OFF (0). Graph walk currently regresses ranking metrics in A/B
  // tests due to hub-node flooding (`thread_summary` nodes are neighbors of
  // nearly everything). Re-enable as default only after hub-damping ships.
  // Agents may still opt in explicitly with graph_depth >= 1.
  if (input == null) return 0;
  // Clamp matches schema (max: 1). Multi-hop is not implemented — depth >= 2
  // would silently degrade to 1, so we clamp rather than mislead callers.
  return clamp(Number(input), 0, 1);
}

export function parseThreadId(input: unknown): string | null {
  return parseOptionalNonEmptyString(input);
}

export function isSemanticSearchKind(kind: SearchableKind): kind is SemanticSearchKind {
  return (SEMANTIC_SEARCH_KINDS as ReadonlySet<string>).has(kind);
}
