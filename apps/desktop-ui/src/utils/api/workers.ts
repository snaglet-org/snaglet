/**
 * UI-side client for /api/workers — background worker controls and status.
 *
 * The knobs are ordinary settings rows underneath (`workers` category), but the
 * UI talks to this endpoint so a single save writes them together and a single
 * read returns policy + runtime state + queue depth.
 */

import { fetchData, getApiUrl } from './core';
import type {
  WorkerPolicyInput,
  WorkerStatusResponse,
  ResolvedWorkerPolicy,
} from '@snaglet/shared/types';

/** Re-export the wire shapes so views don't dig through @snaglet/shared/types. */
export type { WorkerStatusResponse } from '@snaglet/shared/types';

export const workersApi = {
  /** Resolved policy + per-worker runtime state + pending queue depth. */
  status: () => fetchData<WorkerStatusResponse>(getApiUrl('/workers/status')),

  /** Partial update — omitted fields keep their current value. */
  savePolicy: (patch: Partial<WorkerPolicyInput>) =>
    fetchData<ResolvedWorkerPolicy>(getApiUrl('/workers/policy'), {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
};
