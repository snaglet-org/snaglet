/**
 * One shared copy of every automation for the dashboard. The Automations
 * sidebar view and pane, the activity-bar swirl and the status-bar slot all
 * read it, so they agree without each fetching. `useAutomationsFeed` (mounted
 * once by the Dashboard) loads it and re-reads on `automations:changed` and
 * after a reconnect: agents' changes and wakes starting or settling show up
 * without polling.
 */
import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AutomationRecord } from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import { getErrorMessage } from '@snaglet/shared/utils';
import { WebSocketContext } from '@desktop/ws/WebSocketContext';
import { automationsApi } from '@desktop/utils/api/automations';

const AUTOMATIONS_CHANGED_EVENT = 'automations:changed';

export interface AutomationsSnapshot {
  /** null until the first read lands. */
  automations: AutomationRecord[] | null;
  error: string | null;
}

const EMPTY: AutomationsSnapshot = { automations: null, error: null };
let snapshot: AutomationsSnapshot = EMPTY;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let readAgain = false;
/** Bumped by every local write, so a read that started before one is not published over it. */
let writes = 0;

function publish(next: AutomationsSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

/**
 * Re-read every automation. A call while a read is in flight queues one more
 * read after it, so a burst of events costs at most two requests and the last
 * one always sees the newest state. A read that started before a local write
 * ({@link upsertAutomation}) is dropped and read again, so it can't put back
 * what the write replaced.
 */
export function loadAutomations(): Promise<void> {
  if (inFlight) {
    readAgain = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      readAgain = false;
      const writesAtStart = writes;
      try {
        const { automations } = await automationsApi.list('all');
        if (writes !== writesAtStart) {
          readAgain = true;
          continue;
        }
        publish({ automations, error: null });
      } catch (err) {
        publish({ ...snapshot, error: getErrorMessage(err, "Couldn't load automations") });
      }
    } while (readAgain);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Put a record an action just returned into the list (the next read confirms it). */
export function upsertAutomation(record: AutomationRecord): void {
  writes += 1;
  const list = snapshot.automations ?? [];
  const at = list.findIndex((a) => a.id === record.id);
  const next = at === -1 ? [...list, record] : list.map((a, i) => (i === at ? record : a));
  publish({ ...snapshot, automations: next });
}

export function useAutomations(): AutomationsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** One automation from the shared list; undefined until loaded or when unknown. */
export function useAutomation(id: string | null): AutomationRecord | undefined {
  const { automations } = useAutomations();
  return id ? automations?.find((a) => a.id === id) : undefined;
}

/** The automations whose wake is going right now. */
export function useRunningAutomations(): AutomationRecord[] {
  const { automations } = useAutomations();
  return useMemo(() => (automations ?? []).filter((a) => a.running), [automations]);
}

/**
 * Keep the shared list live. Mount once, high in the tree (the Dashboard), so
 * the activity bar and status bar track running wakes even while the
 * Automations view is closed.
 */
export function useAutomationsFeed(): void {
  const ws = useContext(WebSocketContext);
  const addMessageListener = ws?.addMessageListener;
  const connectionState = ws?.connectionState;
  const wasOpen = useRef(false);

  useEffect(() => {
    void loadAutomations();
  }, []);

  useEffect(() => {
    if (!addMessageListener) return;
    return addMessageListener((message) => {
      if (
        message.channel === WORKSPACE_EVENT_CHANNEL &&
        message.type === AUTOMATIONS_CHANGED_EVENT
      ) {
        void loadAutomations();
      }
    });
  }, [addMessageListener]);

  // Events sent while the socket was down are lost, and a server restart ends
  // every live wake: re-read once the socket is back.
  useEffect(() => {
    if (connectionState !== 'open') return;
    if (wasOpen.current) void loadAutomations();
    wasOpen.current = true;
  }, [connectionState]);
}

export function __resetAutomationsStoreForTests(): void {
  snapshot = EMPTY;
  inFlight = null;
  readAgain = false;
  writes = 0;
  listeners.clear();
}
