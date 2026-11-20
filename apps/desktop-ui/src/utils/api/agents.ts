import type { SnagletAgent } from '@snaglet/shared/types';
import type { ActiveWorkItem } from '@snaglet/shared/types/workspace-events';
import { fetchData, getApiUrl } from './core';

/**
 * PATCH body for an agent. `role` may be `null` to clear it: the read shape
 * omits an unset role, but a PATCH that omits the key leaves the stored role.
 */
type AgentUpdate = Omit<Partial<SnagletAgent>, 'role'> & { role?: string | null };

export const agentsApi = {
  /**
   * List agents, omitting archived rows by default. Pickers, sidebar lists and
   * dispatch surfaces must not pass `includeArchived`; only history/attribution
   * surfaces that resolve an archived agent's name opt in (the ArchivedDrawer,
   * the ChatView message-author name map), never a roster you can act on.
   */
  list: (opts?: { includeArchived?: boolean }) => {
    const qs = opts?.includeArchived ? '?includeArchived=true' : '';
    return fetchData<SnagletAgent[]>(getApiUrl(`/agents${qs}`));
  },
  get: (id: string) => fetchData<SnagletAgent>(getApiUrl(`/agents/${id}`)),
  /** In-flight agent work (live runs + executing hooks) — seeds live indicators. */
  activeWork: () =>
    fetchData<{ items: ActiveWorkItem[] }>(getApiUrl('/agents/active-work')).then(
      (data) => data.items
    ),
  create: (data: Partial<SnagletAgent>) =>
    fetchData<SnagletAgent>(getApiUrl('/agents'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: AgentUpdate) =>
    fetchData<SnagletAgent>(getApiUrl(`/agents/${id}`), {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => fetchData<null>(getApiUrl(`/agents/${id}`), { method: 'DELETE' }),
};
