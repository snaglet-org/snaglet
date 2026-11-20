import { fetchData, getApiUrl } from './core';

/**
 * An assignable principal (agent or human user), resolved to a member id +
 * display name. Doc work-item `assignedTo` stores the `id` here. Powers the
 * assignee picker in the doc Properties panel.
 */
export interface MemberOption {
  id: string;
  kind: 'agent' | 'user' | 'external';
  displayName: string;
}

export const membersApi = {
  /** List all assignable members, ordered kind then name. */
  list: () => fetchData<MemberOption[]>(getApiUrl('/members')),
};
