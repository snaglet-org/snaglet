/**
 * Type definitions that don't cluster into a single API domain —
 * chat profile, user profile.
 */

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  picture: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
