import type { FrontendFeatureFlags } from '@snaglet/shared/types';

import { fetchData, getApiUrl } from './core';

export const featureFlagsApi = {
  get: () => fetchData<FrontendFeatureFlags>(getApiUrl('/feature-flags')),
};
