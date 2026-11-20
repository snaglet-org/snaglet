/**
 * The local user's display name: the one a new workspace starts with, and the
 * longest one the user-profile routes accept.
 */

/** The name a new workspace's user has until they choose their own. */
export const DEFAULT_USER_NAME = 'Local User';

/** The longest display name a user may have. */
export const USER_NAME_MAX_LENGTH = 80;

/** Whether `name` is still the starting name (any case, surrounding spaces ignored). */
export function isDefaultUserName(name: string | null | undefined): boolean {
  return (name ?? '').trim().toLowerCase() === DEFAULT_USER_NAME.toLowerCase();
}
