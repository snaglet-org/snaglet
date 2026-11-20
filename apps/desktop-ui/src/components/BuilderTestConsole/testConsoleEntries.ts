/**
 * Session-scoped run history for the builder test consoles (hooks + tools).
 *
 * Entries live in a module-level map keyed by console (`hook:<name>` /
 * `tool:<name>`), so history survives tab switches, pane close/reopen, and
 * builder remounts — but never a full app reload ("session-scoped" by
 * construction, no persistence). `useTestConsoleEntries` is the only way in;
 * Clear drops exactly one console's history.
 */

import { useCallback, useEffect, useState } from 'react';

export interface TestConsoleEntry {
  id: string;
  /** ISO timestamp of when the entry was appended. */
  at: string;
  /** Short headline — the event name for hooks, the tool id for tools. */
  label: string;
  status: 'ok' | 'fail';
  /** Collapsible JSON block (delivered event / tool input). */
  payload?: Record<string, unknown>;
  payloadLabel?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  /** Friendly explanation rendered above the raw output (e.g. the
   *  nested-tool-call refusal translation). */
  note?: string;
}

type NewTestConsoleEntry = Omit<TestConsoleEntry, 'id' | 'at'>;

/** Oldest entries fall off past this — a console, not an archive. */
const MAX_ENTRIES = 50;

const sessionHistories = new Map<string, TestConsoleEntry[]>();
let entrySeq = 0;

export interface TestConsoleEntriesApi {
  /** Newest-first. */
  entries: TestConsoleEntry[];
  append: (entry: NewTestConsoleEntry) => void;
  clear: () => void;
}

/** Test-only: drop every console's history. The map above is module-level
 *  (that's the feature — history survives remounts), which in unit tests
 *  means entries leak across cases sharing a hook/tool name unless reset. */
export function resetTestConsoleEntriesForTests(): void {
  sessionHistories.clear();
}

export function useTestConsoleEntries(sessionKey: string): TestConsoleEntriesApi {
  const [entries, setEntries] = useState<TestConsoleEntry[]>(
    () => sessionHistories.get(sessionKey) ?? []
  );

  useEffect(() => {
    setEntries(sessionHistories.get(sessionKey) ?? []);
  }, [sessionKey]);

  const append = useCallback(
    (entry: NewTestConsoleEntry) => {
      entrySeq += 1;
      const full: TestConsoleEntry = {
        ...entry,
        id: `run-${Date.now()}-${entrySeq}`,
        at: new Date().toISOString(),
      };
      setEntries((current) => {
        const next = [full, ...current].slice(0, MAX_ENTRIES);
        sessionHistories.set(sessionKey, next);
        return next;
      });
    },
    [sessionKey]
  );

  const clear = useCallback(() => {
    sessionHistories.delete(sessionKey);
    setEntries([]);
  }, [sessionKey]);

  return { entries, append, clear };
}
