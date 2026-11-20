/**
 * One run log for automations and scripts: an automation's wakes (its
 * schedule runs) and the scripts' runs, merged on the client by start time,
 * newest first. Each line says what ran, what started it, how it ended and
 * how long it took.
 */
import type { AutomationRecord, AutomationRunRecord, HookRunRecord } from '@snaglet/shared/types';
import { scriptEventLabel } from './automationSentences';

type RunLogStatus = AutomationRunRecord['status'] | HookRunRecord['status'];

export interface RunLogEntry {
  key: string;
  kind: 'automation' | 'script';
  /** What a click opens: the automation's id, or the script's name. */
  ownerId: string;
  /** The automation's or the script's name. */
  name: string;
  /** "Run now", "Schedule", or the event that started a script ("Row changed"). */
  startedBy: string;
  status: RunLogStatus;
  /** "Ran", "Failed", "Skipped", "Running", "Timed out". */
  result: string;
  /** Null while it runs, or when the end was not recorded. */
  durationMs: number | null;
  startedAt: string;
}

/** One automation run, with the automation it belongs to. */
export interface AutomationRunOf {
  automation: Pick<AutomationRecord, 'id' | 'name'>;
  run: AutomationRunRecord;
}

const RESULT: Record<RunLogStatus, string> = {
  succeeded: 'Ran',
  failed: 'Failed',
  skipped: 'Skipped',
  running: 'Running',
  timed_out: 'Timed out',
};

function elapsed(startedAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function automationEntry({ automation, run }: AutomationRunOf): RunLogEntry {
  return {
    key: `automation:${run.id}`,
    kind: 'automation',
    ownerId: automation.id,
    name: automation.name,
    startedBy: run.manual ? 'Run now' : 'Schedule',
    status: run.status,
    result: RESULT[run.status],
    durationMs: run.status === 'running' ? null : elapsed(run.startedAt, run.finishedAt),
    startedAt: run.startedAt,
  };
}

function scriptEntry(run: HookRunRecord): RunLogEntry {
  const startedBy =
    run.source === 'manual'
      ? 'Run now'
      : run.source === 'schedule'
        ? 'Schedule'
        : scriptEventLabel(run.eventName).happened;
  return {
    key: `script:${run.id}`,
    kind: 'script',
    ownerId: run.hookName,
    name: run.hookName,
    startedBy,
    status: run.status,
    result: RESULT[run.status],
    durationMs: run.status === 'running' ? null : run.durationMs,
    startedAt: run.startedAt,
  };
}

/** Both logs as one, newest first, at most `limit` lines. */
export function mergeRunLog(
  automationRuns: readonly AutomationRunOf[],
  scriptRuns: readonly HookRunRecord[],
  limit = 25
): RunLogEntry[] {
  const seen = new Set<string>();
  const entries: RunLogEntry[] = [];
  for (const entry of [...automationRuns.map(automationEntry), ...scriptRuns.map(scriptEntry)]) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  // By instant, not by string: the two logs need not write timestamps alike.
  const at = (entry: RunLogEntry) => Date.parse(entry.startedAt) || 0;
  return entries.sort((a, b) => at(b) - at(a) || b.key.localeCompare(a.key)).slice(0, limit);
}

/** "450 ms", "1.2 s", "42 s", "3 min 5 s", "2 h 10 min". */
export function formatRunDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
