/**
 * One shared read of the first-run state for the Get started pane, the
 * thread banner and the launch decision, so a provider connected in one place
 * updates the others at once. It reads existing endpoints only: the user
 * profile, the `onboarding.seed` and `onboarding.progress` settings, the
 * providers and the saved credentials. It reads again when the window regains
 * focus and whenever `refreshOnboarding` is called.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { getErrorMessage, isRecord } from '@snaglet/shared/utils';
import {
  providersApi,
  settingsApi,
  userProfileApi,
  type Provider,
  type ProviderCredential,
} from '@desktop/utils/api';
import {
  providerState,
  type OnboardingProgress,
  type OnboardingSeed,
  type ProviderState,
} from './onboardingModel';

interface OnboardingSnapshot {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  userId: string | null;
  seed: OnboardingSeed | null;
  progress: OnboardingProgress;
  providers: Provider[];
  credentials: ProviderCredential[];
  provider: ProviderState;
}

const INITIAL: OnboardingSnapshot = {
  status: 'loading',
  error: null,
  userId: null,
  seed: null,
  progress: {},
  providers: [],
  credentials: [],
  provider: { kind: 'none' },
};

let snapshot: OnboardingSnapshot = INITIAL;
let inFlight: Promise<OnboardingSnapshot> | null = null;
const listeners = new Set<() => void>();

function publish(next: OnboardingSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function asSeed(value: unknown): OnboardingSeed | null {
  return isRecord(value) && typeof value.status === 'string'
    ? (value as unknown as OnboardingSeed)
    : null;
}

function progressFor(value: unknown, userId: string): OnboardingProgress {
  if (!isRecord(value)) return {};
  const entry = value[userId];
  return isRecord(entry) ? (entry as OnboardingProgress) : {};
}

async function load(): Promise<OnboardingSnapshot> {
  const [profile, seed, progress, providers, credentials] = await Promise.all([
    userProfileApi.get(),
    settingsApi.get('onboarding', 'seed'),
    settingsApi.get('onboarding', 'progress'),
    providersApi.list(),
    providersApi.listCredentials(),
  ]);
  const mine = progressFor(progress.value, profile.id);
  return {
    status: 'ready',
    error: null,
    userId: profile.id,
    seed: asSeed(seed.value),
    progress: mine,
    providers,
    credentials,
    provider: providerState(providers, credentials, mine),
  };
}

/** Read everything again; concurrent callers share one read. Never rejects. */
export function refreshOnboarding(): Promise<OnboardingSnapshot> {
  inFlight ??= load()
    .then((next) => {
      publish(next);
      return next;
    })
    .catch((err: unknown) => {
      const next: OnboardingSnapshot = {
        ...snapshot,
        status: snapshot.status === 'ready' ? 'ready' : 'error',
        error: getErrorMessage(err, 'Could not load the first-run state'),
      };
      publish(next);
      return next;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Record a step in this person's progress, keeping what is already saved. */
export async function saveOnboardingProgress(patch: OnboardingProgress): Promise<void> {
  const current = snapshot.status === 'ready' ? snapshot : await refreshOnboarding();
  if (!current.userId) return;
  const progress = { ...current.progress, ...patch };
  await settingsApi.putEntry('onboarding', 'progress', [current.userId], progress);
  publish({
    ...current,
    progress,
    provider: providerState(current.providers, current.credentials, progress),
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): OnboardingSnapshot {
  return snapshot;
}

export function useOnboarding(): OnboardingSnapshot {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (snapshot.status !== 'ready') void refreshOnboarding();
    const onFocus = () => void refreshOnboarding();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  return state;
}
