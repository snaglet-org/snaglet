import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * What a fresh read of the file on disk means for an editor that already has
 * it open.
 *
 * - `unchanged`   — disk still matches the baseline the editor loaded.
 * - `refresh`     — disk moved, the buffer was clean, so the new copy was adopted.
 * - `converged`   — disk moved to exactly what the user had typed; re-baselined,
 *                   because there is nothing left to disagree about.
 * - `conflict`    — disk moved and the buffer holds *different* unsaved edits.
 *                   The only case that asks the user anything.
 * - `unavailable` — the file could not be re-read. Evidence of nothing.
 */
export type ExternalChangeVerdict =
  | 'unchanged'
  | 'refresh'
  | 'converged'
  | 'conflict'
  | 'unavailable';

/**
 * Pure three-way comparison. `baseline` is the copy the editor loaded (what it
 * believes is on disk), `buffer` is what the user currently sees.
 */
export function classifyExternalChange(
  disk: string,
  baseline: string,
  buffer: string
): Exclude<ExternalChangeVerdict, 'unavailable'> {
  if (disk === baseline) return 'unchanged';
  if (buffer === baseline) return 'refresh';
  if (buffer === disk) return 'converged';
  return 'conflict';
}

/** The divergence currently being shown to the user. */
interface ExternalChangeConflict {
  /** The file as it is on disk right now — what "reload" would take. */
  disk: string;
}

export interface UseExternalFileChangeOptions {
  /** False while there is no file to watch (create mode, still loading, load failed). */
  enabled: boolean;
  /** Re-read the file. Must resolve to '' for a genuinely absent file. */
  read: () => Promise<string>;
  /** The copy the editor loaded. */
  baseline: string;
  /** What the user currently has in the editor. */
  buffer: string;
  /**
   * Take the disk copy wholesale: re-baseline AND drop the local edits. Used
   * for a clean buffer and for an explicit "use the version on disk".
   */
  onAdopt: (disk: string) => void;
  /**
   * Re-baseline to disk but leave the buffer alone, so the editor stays dirty
   * against the new baseline and the next save deliberately overwrites it.
   */
  onRebaseline: (disk: string) => void;
}

export interface ExternalFileChangeState {
  conflict: ExternalChangeConflict | null;
  /**
   * Re-read and act on the result. Resolves to the verdict so a caller about
   * to write the file can refuse. Safe to call at any time.
   */
  check: () => Promise<ExternalChangeVerdict>;
  /** Resolve the conflict by keeping the user's edits (next save wins). */
  keepMine: () => void;
  /** Resolve the conflict by discarding the user's edits for the disk copy. */
  reloadFromDisk: () => void;
}

/**
 * Watches one file for changes made outside this editor.
 *
 * Hook and tool code is not written only here: an agent handed the work
 * in a thread writes `hook.ts` / `tool.ts` directly, and both builder panels
 * save by full-file overwrite. Without this, a panel left open across that
 * handoff would hold a stale copy and quietly throw the agent's work away on
 * the next save.
 *
 * Detection is deliberately event-driven rather than polled. The file changes
 * because the user went somewhere else — the thread — and came back, so window
 * focus is the moment the answer can differ. The guarantee that nothing is
 * overwritten silently does NOT rest on that listener, though: it rests on the
 * caller awaiting `check()` immediately before it writes.
 */
export function useExternalFileChange(
  options: UseExternalFileChangeOptions
): ExternalFileChangeState {
  const [conflict, setConflict] = useState<ExternalChangeConflict | null>(null);

  // `check` runs from event listeners and from the save path, neither of which
  // re-subscribes per render — so everything it reads lives in a ref rather
  // than in its closure, which would otherwise go stale after the first render.
  const latest = useRef(options);
  latest.current = options;
  const conflictRef = useRef<ExternalChangeConflict | null>(null);
  conflictRef.current = conflict;

  const check = useCallback(async (): Promise<ExternalChangeVerdict> => {
    const { enabled, read, baseline, buffer, onAdopt, onRebaseline } = latest.current;
    if (!enabled) return 'unchanged';

    let disk: string;
    try {
      disk = await read();
    } catch {
      // Failing to read is not the same as finding a change. Leave any existing
      // conflict standing and report that we could not tell, so callers can
      // decide for themselves rather than being handed a false 'unchanged'.
      return 'unavailable';
    }

    const verdict = classifyExternalChange(disk, baseline, buffer);
    switch (verdict) {
      case 'unchanged':
        // Includes the case where the file came back to the baseline on its
        // own — the divergence is over, so stop reporting one.
        setConflict(null);
        break;
      case 'refresh':
        setConflict(null);
        onAdopt(disk);
        break;
      case 'converged':
        setConflict(null);
        onRebaseline(disk);
        break;
      case 'conflict':
        // Re-checking while a conflict is already up replaces it with the
        // newer disk copy, so the text shown and the text the buttons act on
        // are always the same snapshot.
        setConflict({ disk });
        break;
    }
    return verdict;
  }, []);

  // A layout effect, not a passive one: the listener is attached in the same
  // commit that shows the editor, so a focus landing right after the editor
  // appears (before passive effects run) is not missed.
  useLayoutEffect(() => {
    if (!options.enabled) return;
    const onWake = () => {
      if (document.visibilityState === 'hidden') return;
      void check();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [options.enabled, check]);

  const keepMine = useCallback(() => {
    const current = conflictRef.current;
    if (!current) return;
    // Re-baseline to disk without touching the buffer: the editor stays dirty
    // against what is really there, so the save that follows is an overwrite
    // the user chose with the other version in front of them.
    latest.current.onRebaseline(current.disk);
    setConflict(null);
  }, []);

  const reloadFromDisk = useCallback(() => {
    const current = conflictRef.current;
    if (!current) return;
    latest.current.onAdopt(current.disk);
    setConflict(null);
  }, []);

  return { conflict, check, keepMine, reloadFromDisk };
}
