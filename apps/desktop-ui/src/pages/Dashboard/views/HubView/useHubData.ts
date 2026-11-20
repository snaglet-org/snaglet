/**
 * The Home pane's data, one hook per source. Every source is an existing
 * endpoint: the user profile (one read shared with Get started), the
 * workspace tree (recents and pin lookups), the table catalog, thread
 * participants and messages, the agents list, and two settings
 * (`agent.global_instructions` and `home.pinned`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  SETTINGS_CHANGED_EVENT,
  SETTINGS_EVENT_CHANNEL,
  type SettingsChangedEvent,
  type SnagletAgent,
  type TableCatalogEntry,
  type WsMessage,
} from '@snaglet/shared/types';
import { useWs } from '@desktop/ws/useWs';
import {
  agentsApi,
  containersApi,
  settingsApi,
  tablesApi,
  threadsApi,
  type ThreadMessage,
} from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { subscribeTableEvents } from '@desktop/features/database/tableEvents';
import { useUserProfile, type UserProfileState } from '@desktop/features/user-profile/userProfile';
import {
  indexTree,
  messageSnippet,
  pinKey,
  readPins,
  threadActivityAt,
  type IndexedThread,
  type PinKind,
  type PinRecord,
  type TreeIndex,
} from './hubModel';
import type { HubAgentFace, LoadStatus } from './hubTypes';

/** `agent.global_instructions`, the text added to every agent's system prompt. */
const INSTRUCTIONS = { category: 'agent', key: 'global_instructions' } as const;
/** `home.pinned`: user id → `<kind>:<id>` → pin. */
const PINNED = { category: 'home', key: 'pinned' } as const;

/** Tree refetches after a burst of workspace events wait this long. */
const TREE_REFRESH_DEBOUNCE_MS = 400;

// ── Profile ────────────────────────────────────────────────────────────────

export type HubProfileState = UserProfileState;

/** The shared profile, so a name saved here or in Get started shows in both at once. */
export function useHubProfile(): HubProfileState {
  return useUserProfile();
}

// ── Workspace tree ─────────────────────────────────────────────────────────

export interface HubTreeState {
  status: LoadStatus;
  index: TreeIndex | null;
  error: string | null;
  /** Read the tree again (the error state's Try again). */
  reload: () => void;
}

/**
 * The workspace tree, indexed. Read again (debounced) after any change that
 * can move, rename, add, remove or re-date a doc, thread or project. A failed
 * refresh keeps the last good tree.
 */
export function useHubTree(): HubTreeState {
  const [index, setIndex] = useState<TreeIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let timer: number | undefined;
    const off = onLibraryEvent((event) => {
      if (
        event.type === 'renamed' ||
        event.type === 'node-moved' ||
        event.type === 'tree-invalidated' ||
        event.type === 'created' ||
        event.type === 'deleted' ||
        event.type === 'archive-changed' ||
        event.type === 'doc-saved'
      ) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setNonce((n) => n + 1), TREE_REFRESH_DEBOUNCE_MS);
      }
    });
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    containersApi
      .listTree()
      .then((tree) => {
        if (canceled) return;
        setIndex(indexTree(tree ?? []));
        setError(null);
      })
      .catch((err: unknown) => {
        if (!canceled) setError(getErrorMessage(err, 'Could not load the workspace'));
      });
    return () => {
      canceled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => {
    setError(null);
    setNonce((n) => n + 1);
  }, []);

  return {
    status: index ? 'ready' : error ? 'error' : 'loading',
    index,
    error: index ? null : error,
    reload,
  };
}

// ── Table catalog ──────────────────────────────────────────────────────────

export interface HubTablesState {
  status: LoadStatus;
  /** The catalog (archived tables included, marked by `state`); null until read. */
  tables: TableCatalogEntry[] | null;
  error: string | null;
  /** Read the catalog again (the error state's Try again). */
  reload: () => void;
}

/**
 * The table catalog the workspace tree and the palette read, while `enabled`
 * (a table is pinned, or the pin picker is open), and again after any table
 * event. A failed refresh keeps the last good list.
 */
export function useHubTables(enabled: boolean): HubTablesState {
  const [tables, setTables] = useState<TableCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    return subscribeTableEvents(() => setNonce((n) => n + 1));
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    tablesApi
      .list()
      .then((result) => {
        if (canceled) return;
        setTables(result.tables);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!canceled) setError(getErrorMessage(err, 'Could not load tables'));
      });
    return () => {
      canceled = true;
    };
  }, [enabled, nonce]);

  const reload = useCallback(() => {
    setError(null);
    setNonce((n) => n + 1);
  }, []);

  return {
    status: tables ? 'ready' : error ? 'error' : 'loading',
    tables,
    error: tables ? null : error,
    reload,
  };
}

// ── Pins ───────────────────────────────────────────────────────────────────

export interface HubPinsState {
  status: LoadStatus;
  error: string | null;
  pins: PinRecord[];
  isPinned: (kind: PinKind, id: string) => boolean;
  pin: (item: { kind: PinKind; id: string; title: string }) => Promise<void>;
  unpin: (kind: PinKind, id: string) => Promise<void>;
  /** Read the pins again (the error state's Try again). */
  reload: () => void;
}

/**
 * The active user's pins from `home.pinned`. Pin and unpin show at once and
 * write one entry; a failed write puts the list back and reports why.
 */
export function useHubPins(userId: string | null): HubPinsState {
  const [pins, setPins] = useState<PinRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const pinsRef = useRef<PinRecord[] | null>(null);
  pinsRef.current = pins;

  useEffect(() => {
    if (!userId) return;
    let canceled = false;
    setPins(null);
    setError(null);
    settingsApi
      .get(PINNED.category, PINNED.key)
      .then((record) => {
        if (!canceled) setPins(readPins(record.value, userId));
      })
      .catch((err: unknown) => {
        if (!canceled) setError(getErrorMessage(err, 'Could not load your pins'));
      });
    return () => {
      canceled = true;
    };
  }, [userId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const pin = useCallback(
    async (item: { kind: PinKind; id: string; title: string }) => {
      if (!userId) return;
      const before = pinsRef.current ?? [];
      if (before.some((p) => p.kind === item.kind && p.id === item.id)) return;
      const record: PinRecord = { ...item, pinnedAt: new Date().toISOString() };
      setPins([...before, record]);
      setError(null);
      try {
        const map = await settingsApi.putEntry(
          PINNED.category,
          PINNED.key,
          [userId, pinKey(item.kind, item.id)],
          record
        );
        setPins(readPins(map, userId));
      } catch (err) {
        setPins(before);
        setError(getErrorMessage(err, 'Could not pin that'));
      }
    },
    [userId]
  );

  const unpin = useCallback(
    async (kind: PinKind, id: string) => {
      if (!userId) return;
      const before = pinsRef.current ?? [];
      setPins(before.filter((p) => !(p.kind === kind && p.id === id)));
      setError(null);
      try {
        const map = await settingsApi.deleteEntry(PINNED.category, PINNED.key, [
          userId,
          pinKey(kind, id),
        ]);
        setPins(readPins(map, userId));
      } catch (err) {
        setPins(before);
        setError(getErrorMessage(err, 'Could not unpin that'));
      }
    },
    [userId]
  );

  const pinnedKeys = useMemo(() => new Set((pins ?? []).map((p) => pinKey(p.kind, p.id))), [pins]);
  const isPinned = useCallback(
    (kind: PinKind, id: string) => pinnedKeys.has(pinKey(kind, id)),
    [pinnedKeys]
  );

  return {
    status: pins ? 'ready' : error ? 'error' : 'loading',
    error,
    pins: pins ?? [],
    isPinned,
    pin,
    unpin,
    reload,
  };
}

// ── Recent thread details ──────────────────────────────────────────────────

export interface ThreadDetails {
  status: LoadStatus;
  agents: HubAgentFace[];
  snippet: { sender: string | null; text: string } | null;
}

/** Messages read per thread to find its last real one (events and run errors are skipped). */
const SNIPPET_WINDOW = 6;

function agentFace(agent: SnagletAgent): HubAgentFace {
  return {
    id: agent.id,
    name: agent.name,
    avatarUrl: agent.avatarUrl ?? null,
    cursorSpec: agent.cursorSpec ?? null,
  };
}

function lastSnippet(
  messages: ThreadMessage[],
  agents: Map<string, SnagletAgent>
): ThreadDetails['snippet'] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    // A failed run's notice ("⚠ No model configured …") is not something the
    // agent said, so the preview shows the message before it.
    if (!message || message.messageType === 'thread_event' || message.runError) continue;
    const text = messageSnippet(message.content);
    if (!text) continue;
    const sender =
      message.role === 'user'
        ? (message.externalSender?.name ?? 'You')
        : message.agentId
          ? (agents.get(message.agentId)?.name ?? message.originalAgentName ?? null)
          : null;
    return { sender, text };
  }
  return null;
}

/**
 * Agents and last message for each listed thread. Each thread is read once
 * per activity time, so a new message (a newer `lastMessageAt` in the tree)
 * reads it again; a thread whose read fails keeps its row without them.
 */
export function useThreadDetails(threads: IndexedThread[]): Map<string, ThreadDetails> {
  const [details, setDetails] = useState<Map<string, ThreadDetails>>(() => new Map());
  const agentsRef = useRef<Promise<Map<string, SnagletAgent>> | null>(null);
  const loadedRef = useRef(new Map<string, string>());

  const wanted = useMemo(
    () => threads.map((t) => ({ id: t.node.id, at: threadActivityAt(t.node) })),
    [threads]
  );

  useEffect(() => {
    let canceled = false;
    // Reads this run started and has not finished; a superseded run forgets
    // them so the next run reads those threads again.
    const pending = new Set<string>();
    agentsRef.current ??= agentsApi
      .list()
      .then((rows) => new Map(rows.map((agent) => [agent.id, agent])))
      .catch(() => new Map<string, SnagletAgent>());
    const agentsPromise = agentsRef.current;

    for (const { id, at } of wanted) {
      if (loadedRef.current.get(id) === at) continue;
      loadedRef.current.set(id, at);
      pending.add(id);
      setDetails((current) => {
        if (current.has(id)) return current;
        const next = new Map(current);
        next.set(id, { status: 'loading', agents: [], snippet: null });
        return next;
      });
      void Promise.all([
        agentsPromise,
        threadsApi.listParticipants(id),
        threadsApi.getMessages(id, { limit: SNIPPET_WINDOW }),
      ])
        .then(([agents, participants, page]) => {
          pending.delete(id);
          if (canceled) return;
          const faces = participants
            .filter((p) => p.kind === 'agent' && p.agentId)
            .map((p) => agents.get(p.agentId))
            .filter((agent): agent is SnagletAgent => !!agent)
            .map(agentFace);
          setDetails((current) =>
            new Map(current).set(id, {
              status: 'ready',
              agents: faces,
              snippet: lastSnippet(page.messages, agents),
            })
          );
        })
        .catch(() => {
          pending.delete(id);
          if (canceled) return;
          loadedRef.current.delete(id);
          setDetails((current) =>
            new Map(current).set(id, { status: 'error', agents: [], snippet: null })
          );
        });
    }
    return () => {
      canceled = true;
      for (const id of pending) loadedRef.current.delete(id);
    };
  }, [wanted]);

  return details;
}

// ── Instructions for all agents ────────────────────────────────────────────

export interface HubInstructionsState {
  status: LoadStatus;
  /** The saved text; null until loaded. */
  saved: string | null;
  error: string | null;
  /** Save the text. Rejects with the server's reason. */
  save: (value: string) => Promise<void>;
}

export function useGlobalInstructions(): HubInstructionsState {
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const { subscribe, unsubscribe, addMessageListener, connectionState } = useWs();

  // An agent's `workspace_instructions` set (or another window's save) changes
  // the setting: reread it on `settings:changed` and after a reconnect, since
  // frames sent while the socket was down are lost.
  const wasOpen = useRef(connectionState === 'open');
  useEffect(() => {
    if (connectionState !== 'open') {
      wasOpen.current = false;
      return;
    }
    if (!wasOpen.current) setNonce((n) => n + 1);
    wasOpen.current = true;
    subscribe(SETTINGS_EVENT_CHANNEL);
    return () => unsubscribe(SETTINGS_EVENT_CHANNEL);
  }, [connectionState, subscribe, unsubscribe]);
  useEffect(
    () =>
      addMessageListener((message: WsMessage) => {
        if (message.channel !== SETTINGS_EVENT_CHANNEL || message.type !== SETTINGS_CHANGED_EVENT) {
          return;
        }
        const change = message.payload as Partial<SettingsChangedEvent> | null;
        if (change?.category === INSTRUCTIONS.category && change.key === INSTRUCTIONS.key) {
          setNonce((n) => n + 1);
        }
      }),
    [addMessageListener]
  );

  useEffect(() => {
    let canceled = false;
    settingsApi
      .get(INSTRUCTIONS.category, INSTRUCTIONS.key)
      .then((record) => {
        if (!canceled) setSaved(typeof record.value === 'string' ? record.value : '');
      })
      .catch((err: unknown) => {
        if (!canceled) setError(getErrorMessage(err, 'Could not load the instructions'));
      });
    return () => {
      canceled = true;
    };
  }, [nonce]);

  const save = useCallback(async (value: string) => {
    await settingsApi.put(INSTRUCTIONS.category, INSTRUCTIONS.key, value);
    setSaved(value);
  }, []);

  return {
    status: saved !== null ? 'ready' : error ? 'error' : 'loading',
    saved,
    error,
    save,
  };
}
