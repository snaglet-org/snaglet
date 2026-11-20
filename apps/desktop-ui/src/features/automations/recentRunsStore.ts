/**
 * The automations' recent runs for the Automations view's run log: one read of
 * `GET /api/automations/runs/recent`, kept here across tab switches. A view
 * asks for runs current with the automations' run state (`want(key)`); the
 * cache reads again only when that state changed since its last read (a wake
 * started or settled, an automation came or went). A request while a read is
 * in flight is served by one more read after it.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { AutomationRecentRun, AutomationRecord } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { automationsApi } from '@desktop/utils/api/automations';

/** Lines the merged run log shows; the automations' share is read to match. */
export const RUN_LOG_LINES = 20;

interface RecentRunsSnapshot {
  /** Null until the first read lands. */
  runs: AutomationRecentRun[] | null;
  /** The last read failed (the runs shown, if any, are older). */
  failed: boolean;
}

let snapshot: RecentRunsSnapshot = { runs: null, failed: false };
/** The run state the cached runs were read for, and the one asked for. */
let readFor: string | null = null;
let wanted: string | null = null;
let reading = false;
const listeners = new Set<() => void>();

function publish(next: RecentRunsSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function read(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    while (wanted !== null && wanted !== readFor) {
      const key = wanted;
      try {
        const { runs } = await automationsApi.recentRuns(RUN_LOG_LINES);
        readFor = key;
        publish({ runs, failed: false });
      } catch (err) {
        console.warn('[automations] recent runs did not load:', getErrorMessage(err));
        publish({ runs: snapshot.runs, failed: true });
        // Asked again (a remount, the next run) it reads again; no retry loop.
        break;
      }
    }
  } finally {
    reading = false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * What changes on the listed automations when a run starts or ends, or one
 * comes or goes: the cache's key. A rename or an edit does not count (lines
 * take the current name from the list).
 */
export function automationRunsKey(automations: readonly AutomationRecord[]): string {
  return automations
    .map((a) =>
      [
        a.id,
        a.running,
        a.runningSince ?? '',
        a.lastRun?.status ?? '',
        a.lastRun?.scheduledFor ?? '',
        a.lastRun?.finishedAt ?? '',
      ].join(':')
    )
    .sort()
    .join('|');
}

/** The cached recent runs, read again only when `key` differs from the last read's. */
export function useRecentAutomationRuns(key: string): RecentRunsSnapshot {
  const value = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => {
    wanted = key;
    void read();
  }, [key]);
  return value;
}

export function __resetRecentAutomationRunsForTests(): void {
  snapshot = { runs: null, failed: false };
  readFor = null;
  wanted = null;
  reading = false;
}
