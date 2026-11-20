/**
 * The active user's profile, one shared read for the surfaces that show or
 * rename it (Home's greeting, the Get started pane), so a name saved in one
 * shows in the others at once. Each surface reads it again when it mounts,
 * so a name changed in Settings → Profile shows the next time one opens.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { USER_NAME_MAX_LENGTH } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { userProfileApi, type UserProfile } from '@desktop/utils/api';

export interface UserProfileState {
  status: 'loading' | 'ready' | 'error';
  profile: UserProfile | null;
  error: string | null;
  /** Rename the active user. Rejects with the server's reason. */
  saveName: (name: string) => Promise<void>;
}

type Snapshot = Omit<UserProfileState, 'saveName'>;

let snapshot: Snapshot = { status: 'loading', profile: null, error: null };
let inFlight: Promise<void> | null = null;
// Bumped by every save, so a read sent before it never lands after it.
let saves = 0;
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Read the profile; concurrent callers share one read. A failed read keeps a profile already read. */
function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  const savesAtStart = saves;
  inFlight = userProfileApi
    .get()
    .then((profile) => {
      if (saves === savesAtStart) publish({ status: 'ready', profile, error: null });
    })
    .catch((err: unknown) => {
      if (snapshot.profile) return;
      publish({
        status: 'error',
        profile: null,
        error: getErrorMessage(err, 'Could not load your profile'),
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function saveName(name: string): Promise<void> {
  const profile = await userProfileApi.update({ name });
  saves += 1;
  publish({ status: 'ready', profile, error: null });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Snapshot {
  return snapshot;
}

export function useUserProfile(): UserProfileState {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void refresh();
  }, []);
  return { ...state, saveName };
}

/**
 * A typed name as it is saved (trimmed), or why it cannot be. The server
 * checks the rest: reserved names and names another user has.
 */
export function checkUserName(
  draft: string
): { name: string; error: null } | { name: null; error: string } {
  const name = draft.trim();
  if (!name) return { name: null, error: 'Your name can’t be empty.' };
  if (name.length > USER_NAME_MAX_LENGTH) {
    return { name: null, error: `Your name can be at most ${USER_NAME_MAX_LENGTH} characters.` };
  }
  return { name, error: null };
}
