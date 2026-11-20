import { fetchData, getApiUrl } from './core';
import type { UserProfile } from './types';

/** A selectable identity in the user picker (settings → profile). */
export interface UserOption {
  id: string;
  name: string;
  email: string;
  picture: string | null;
  active: boolean;
}

interface CreateUserInput {
  name: string;
  email?: string;
  picture?: string | null;
  makeActive?: boolean;
}

export const userProfileApi = {
  get: () => fetchData<UserProfile>(getApiUrl('/user-profile')),

  update: (data: { name?: string; email?: string }) =>
    fetchData<UserProfile>(getApiUrl('/user-profile'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  /** List all users — options for the identity picker. */
  listUsers: () => fetchData<UserOption[]>(getApiUrl('/user-profile/users')),

  createUser: (data: CreateUserInput) =>
    fetchData<UserProfile>(getApiUrl('/user-profile/users'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  /** Mark a user as the active desktop user (clears active flag on all others). */
  setActive: (id: string) =>
    fetchData<UserProfile>(getApiUrl(`/user-profile/active/${id}`), { method: 'POST' }),
};
