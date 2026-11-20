/**
 * The local reranker is off unless the `reranker` row in `feature_flags` is
 * enabled. While it is off Snaglet never downloads or loads the model, and
 * committed search keeps its hybrid order. There is no UI toggle; see
 * docs/dev-environment.md for the SQL that turns it on.
 */
import { featureFlagService } from '@server/services/FeatureFlagService';

export const RERANKER_OFF_MESSAGE = 'Reranking is turned off (feature flag `reranker`).';

export function isRerankerEnabled(): Promise<boolean> {
  return featureFlagService.isServerFlagEnabled('reranker');
}
