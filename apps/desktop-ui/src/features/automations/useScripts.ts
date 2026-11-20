import { useCallback, useEffect, useRef, useState } from 'react';
import {
  hooksWorkspacesApi,
  type HookRegistrationInfo,
  type HookWorkspaceInfo,
} from '@desktop/utils/api';
import { emitLibraryEvent, onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { ScriptDeclaration } from './automationSentences';

/** What the list shows of a script's build: absent while the scanner has not seen it. */
export interface ScriptBuild {
  status: HookRegistrationInfo['buildStatus'];
  lastError: string | null;
}

interface ScriptsState {
  /** Installed scripts (`~/.snaglet/hooks/<name>/`); null until the first read. */
  scripts: HookWorkspaceInfo[] | null;
  error: string | null;
  /** name → whether it runs automatically; absent for a script not registered yet. */
  enabledByName: ReadonlyMap<string, boolean>;
  buildByName: ReadonlyMap<string, ScriptBuild>;
  /** name → what its saved code declares; absent when not registered. */
  declaredByName: ReadonlyMap<string, ScriptDeclaration>;
  /** Scripts whose switch has a request in flight. */
  toggling: ReadonlySet<string>;
  toggleError: string | null;
  setEnabled: (name: string, enabled: boolean) => Promise<void>;
  /** Drop a script moved to the Trash from here, and tell the other surfaces. */
  removed: (name: string) => void;
}

function withEnabled(
  flags: ReadonlyMap<string, boolean>,
  name: string,
  enabled: boolean
): ReadonlyMap<string, boolean> {
  if (flags.get(name) === enabled) return flags;
  return new Map(flags).set(name, enabled);
}

/**
 * The installed scripts for the Automations list: their folders, their
 * registrations (on/off and build state) and what each declares. Kept in step
 * with the script page (`hook-saved`), the Trash (`hook-deleted`), on/off
 * flips made anywhere (`hook-enabled-changed`) and the server's registry
 * (`hook-registry-changed`: a build started or ended, a folder came or went).
 * A failed registry read leaves the rows without a switch or a "when"; the
 * list itself still shows.
 */
export function useScripts(): ScriptsState {
  const [scripts, setScripts] = useState<HookWorkspaceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabledByName, setEnabledByName] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [buildByName, setBuildByName] = useState<ReadonlyMap<string, ScriptBuild>>(() => new Map());
  const [declaredByName, setDeclaredByName] = useState<ReadonlyMap<string, ScriptDeclaration>>(
    () => new Map()
  );
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);

  const alive = useRef(true);
  const reading = useRef(false);
  const readAgain = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One pass reads the folders and the registry (each script's on/off flag,
  // build state and what it declares). A request while a pass is in flight
  // runs one more pass after it, so a burst of registry events costs at most
  // two. A failed registry read leaves the rows as they were.
  const refresh = useCallback(async () => {
    if (reading.current) {
      readAgain.current = true;
      return;
    }
    reading.current = true;
    try {
      do {
        readAgain.current = false;
        const [folders, registry] = await Promise.allSettled([
          hooksWorkspacesApi.list(),
          hooksWorkspacesApi.registry(),
        ]);
        if (!alive.current) return;
        if (folders.status === 'fulfilled') {
          setScripts(folders.value);
          setError(null);
        } else {
          setError(getErrorMessage(folders.reason, "Couldn't load scripts"));
        }
        if (registry.status === 'fulfilled') {
          const rows = registry.value;
          setEnabledByName(new Map(rows.map((row) => [row.name, row.enabled])));
          setBuildByName(
            new Map(
              rows.map((row) => [row.name, { status: row.buildStatus, lastError: row.lastError }])
            )
          );
          setDeclaredByName(
            new Map(
              rows.flatMap((row) =>
                row.declared ? [[row.name, row.declared] as [string, ScriptDeclaration]] : []
              )
            )
          );
        } else {
          console.error(
            '[automations] reading script registrations failed',
            getErrorMessage(registry.reason)
          );
        }
      } while (readAgain.current && alive.current);
    } finally {
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The script page saves outside this list. A rename carries
  // `previousHookName`: the new name matches no cached row, so match the old
  // one, and append when the row is already gone rather than drop the update.
  // The registry says when a build starts or ends, or a folder comes or goes
  // (an agent's new script, a file edit): the list reads again.
  useEffect(
    () =>
      onLibraryEvent((event) => {
        if (event.type === 'hook-enabled-changed') {
          setEnabledByName((flags) => withEnabled(flags, event.hookName, event.enabled));
          return;
        }
        if (event.type === 'hook-deleted') {
          setScripts((rows) => rows?.filter((row) => row.hookName !== event.hookName) ?? rows);
          return;
        }
        if (event.type === 'hook-registry-changed') {
          void refresh();
          return;
        }
        if (event.type !== 'hook-saved') return;
        const matchName = event.previousHookName ?? event.hook.hookName;
        setScripts((rows) => {
          const current = rows ?? [];
          if (!current.some((row) => row.hookName === matchName)) return [...current, event.hook];
          return current.map((row) => (row.hookName === matchName ? event.hook : row));
        });
        void refresh();
      }),
    [refresh]
  );

  const setEnabled = useCallback(async (name: string, next: boolean) => {
    setToggleError(null);
    setEnabledByName((flags) => withEnabled(flags, name, next));
    setToggling((names) => new Set(names).add(name));
    try {
      const row = await hooksWorkspacesApi.setEnabled(name, next);
      setEnabledByName((flags) => withEnabled(flags, name, row.enabled));
      emitLibraryEvent({ type: 'hook-enabled-changed', hookName: name, enabled: row.enabled });
    } catch (err) {
      setEnabledByName((flags) => withEnabled(flags, name, !next));
      setToggleError(getErrorMessage(err, `Couldn't turn ${name} ${next ? 'on' : 'off'}`));
    } finally {
      setToggling((names) => {
        const rest = new Set(names);
        rest.delete(name);
        return rest;
      });
    }
  }, []);

  const removed = useCallback((name: string) => {
    setScripts((rows) => rows?.filter((row) => row.hookName !== name) ?? rows);
    emitLibraryEvent({ type: 'hook-deleted', hookName: name });
  }, []);

  return {
    scripts,
    error,
    enabledByName,
    buildByName,
    declaredByName,
    toggling,
    toggleError,
    setEnabled,
    removed,
  };
}
