/**
 * The agent page's Direct messages tab: the agent's DM conversations on the
 * left, the selected one in DmView on the right. The user's home thread with
 * the agent is always first and selected by default (the pane offers to start
 * it, POST /threads/dm, when it does not exist); agent-to-agent threads follow,
 * read-only.
 *
 * The rows come from the agent's DM list plus the user's own list, which
 * supplies the unread badges (always the user's unread, so agent-to-agent
 * threads carry none). Refreshes are debounced and run on a message or read
 * mark in a listed thread, a notification, reconnect, and after a delete.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from 'react';
import { Button } from '@desktop/components';
import {
  DmAvatar,
  PartyName,
  onDmRead,
  useDmThreadActivity,
  type DmAvatarParty,
} from '@desktop/features/dms';
import { agentsApi, threadsApi, type DmThreadSummary } from '@desktop/utils/api';
import { useUnreadCount } from '@desktop/utils/notificationState';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { formatRelativeTime, getErrorMessage } from '@snaglet/shared/utils';
import type { SnagletAgent } from '@snaglet/shared/types';
import { useSidebarWidth } from '../../hooks/useSidebarWidth';
import { DmView } from '../DmView';
import styles from './AgentDmsTab.module.scss';

/** Selection key of the user's home thread with this agent. */
const USER_KEY = 'user';

/** Quiet time before a refresh runs (one window for a message and its read mark). */
const DM_REFRESH_DEBOUNCE_MS = 300;

/** The conversation list's draggable width (px), saved apart from the sidebar's. */
const LIST_WIDTH = {
  storageKey: 'snaglet.agent.dmTabListWidth',
  defaultWidth: 176,
  min: 140,
  max: 360,
};

interface AgentDmsTabProps {
  agent: SnagletAgent;
}

const UnreadBadge: FC<{ count: number }> = ({ count }) =>
  count > 0 ? (
    <span className={styles.badge} aria-label={`${count} unread`}>
      {count > 99 ? '99+' : count}
    </span>
  ) : null;

export const AgentDmsTab: FC<AgentDmsTabProps> = ({ agent }) => {
  const agentId = agent.id;
  const dmOff = agent.dmEnabled === false;
  const [agentThreads, setAgentThreads] = useState<DmThreadSummary[] | null>(null);
  const [userThreads, setUserThreads] = useState<DmThreadSummary[]>([]);
  const [others, setOthers] = useState<ReadonlyMap<string, SnagletAgent>>(() => new Map());
  const [selected, setSelected] = useState<string>(USER_KEY);
  // The home thread, as just created here, until the lists show it.
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listResize = useSidebarWidth(LIST_WIDTH);

  // Trailing debounce: a burst of triggers collapses into one refresh.
  const [listsNonce, setListsNonce] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshLists = useCallback(() => {
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      setListsNonce((n) => n + 1);
    }, DM_REFRESH_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    },
    []
  );

  // Who is who, once: the other agents' avatars.
  useEffect(() => {
    let canceled = false;
    agentsApi.list({ includeArchived: true }).then(
      (rows) => {
        if (!canceled) setOthers(new Map(rows.map((row) => [row.id, row])));
      },
      (err: unknown) => console.warn(`[dms] couldn't load agents: ${getErrorMessage(err)}`)
    );
    return () => {
      canceled = true;
    };
  }, []);

  // The agent's conversations and the user's own list; a refresh that a newer
  // one overtook is dropped (the effect cleanup cancels it).
  useEffect(() => {
    let canceled = false;
    Promise.all([threadsApi.listDms(agentId), threadsApi.listDms()]).then(
      ([forAgent, forUser]) => {
        if (canceled) return;
        setAgentThreads(forAgent);
        setUserThreads(forUser);
        setError(null);
      },
      (err: unknown) => {
        if (!canceled) setError(`Couldn’t load the conversations: ${getErrorMessage(err)}`);
      }
    );
    return () => {
      canceled = true;
    };
  }, [agentId, listsNonce]);

  const userThread = useMemo(
    () => (agentThreads ?? []).find((thread) => thread.withKind === 'user') ?? null,
    [agentThreads]
  );
  const userThreadId = userThread?.id ?? created?.id ?? null;
  const agentToAgent = useMemo(
    () => (agentThreads ?? []).filter((thread) => thread.withKind !== 'user'),
    [agentThreads]
  );
  const unreadById = useMemo(
    () => new Map(userThreads.map((thread) => [thread.id, thread.unread])),
    [userThreads]
  );

  const listedIds = useMemo(
    () => [...(agentThreads ?? []).map((thread) => thread.id), ...(created ? [created.id] : [])],
    [agentThreads, created]
  );
  const listedRef = useRef(new Set<string>());
  listedRef.current = new Set(listedIds);

  useDmThreadActivity(listedIds, refreshLists);

  // A new notification may be this agent's first DM to the user.
  const notificationCount = useUnreadCount();
  const seenNotifications = useRef(notificationCount);
  useEffect(() => {
    if (notificationCount > seenNotifications.current) refreshLists();
    seenNotifications.current = notificationCount;
  }, [notificationCount, refreshLists]);

  // The user read a listed conversation in the pane: its badge clears.
  useEffect(
    () =>
      onDmRead((threadId) => {
        if (listedRef.current.has(threadId)) refreshLists();
      }),
    [refreshLists]
  );

  // A conversation is gone (deleted here or elsewhere): its row drops, the
  // pane closes, and the home thread row falls back to "create on first open".
  const dropListed = useCallback(
    (threadId: string) => {
      setAgentThreads((threads) =>
        threads ? threads.filter((thread) => thread.id !== threadId) : threads
      );
      setUserThreads((threads) => threads.filter((thread) => thread.id !== threadId));
      setCreated((current) => (current?.id === threadId ? null : current));
      setSelected((current) => (current === threadId ? USER_KEY : current));
      refreshLists();
    },
    [refreshLists]
  );
  useEffect(
    () =>
      onLibraryEvent((event) => {
        if (event.type === 'deleted' && event.kind === 'thread') {
          if (listedRef.current.has(event.id)) dropListed(event.id);
        } else if (event.type === 'tree-invalidated' && event.ids.length === 0) {
          refreshLists();
        }
      }),
    [dropListed, refreshLists]
  );

  const startConversation = useCallback(async () => {
    setError(null);
    setCreating(true);
    try {
      setCreated(await threadsApi.openDm(agentId));
      setSelected(USER_KEY);
      refreshLists();
    } catch (err) {
      setError(`Couldn’t start the home thread with ${agent.name}: ${getErrorMessage(err)}`);
    } finally {
      setCreating(false);
    }
  }, [agentId, agent.name, refreshLists]);

  const partyOf = (thread: DmThreadSummary): DmAvatarParty => {
    if (thread.withKind === 'user') return { kind: 'user', name: thread.withName };
    const id = thread.withAgentId ?? thread.id;
    const other = others.get(id);
    return {
      kind: 'agent',
      agentId: id,
      cursorSpec: other?.cursorSpec ?? null,
      avatarUrl: other?.avatarUrl ?? null,
    };
  };

  const shownThreadId = selected === USER_KEY ? userThreadId : selected;
  const userSelected = selected === USER_KEY;

  return (
    <div className={styles.root}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.layout}>
        <div
          className={styles.listColumn}
          style={{ '--dm-list-width': `${listResize.width}px` } as CSSProperties}
          data-testid="dm-list-column"
        >
          <div className={styles.list} role="list" aria-label={`${agent.name}’s conversations`}>
            <button
              type="button"
              role="listitem"
              className={`${styles.row} ${userSelected ? styles.rowSelected : ''}`}
              aria-current={userSelected}
              aria-selected={userSelected}
              data-testid="dm-row-user"
              title={`Your home thread with ${agent.name}`}
              onClick={() => setSelected(USER_KEY)}
            >
              <span className={styles.identity}>
                <span className={styles.name}>Home thread</span>
                <span className={styles.meta}>
                  {userThread?.lastMessageAt
                    ? formatRelativeTime(userThread.lastMessageAt)
                    : 'No messages yet'}
                </span>
              </span>
              <UnreadBadge count={userThreadId ? (unreadById.get(userThreadId) ?? 0) : 0} />
            </button>
            {agentToAgent.map((thread) => (
              <button
                key={thread.id}
                type="button"
                role="listitem"
                className={`${styles.row} ${selected === thread.id ? styles.rowSelected : ''}`}
                aria-current={selected === thread.id}
                aria-selected={selected === thread.id}
                data-testid={`dm-row-${thread.id}`}
                onClick={() => setSelected(thread.id)}
              >
                <DmAvatar party={partyOf(thread)} />
                <span className={styles.identity}>
                  <span className={styles.name}>
                    <PartyName name={thread.withName} />
                  </span>
                  <span className={styles.meta}>
                    {thread.lastMessageAt
                      ? formatRelativeTime(thread.lastMessageAt)
                      : 'No messages yet'}
                  </span>
                </span>
                <UnreadBadge count={unreadById.get(thread.id) ?? 0} />
              </button>
            ))}
          </div>
          <div
            className={`${styles.resizer} ${listResize.isResizing ? styles.resizerActive : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize conversation list"
            aria-valuemin={listResize.minWidth}
            aria-valuemax={listResize.maxWidth}
            aria-valuenow={listResize.width}
            tabIndex={0}
            onPointerDown={listResize.onResizerPointerDown}
            onKeyDown={listResize.onResizerKeyDown}
            onDoubleClick={listResize.resetWidth}
            title="Drag to resize · double-click to reset"
          />
        </div>
        <div className={styles.pane}>
          {shownThreadId ? (
            <DmView
              key={shownThreadId}
              threadId={shownThreadId}
              title={
                shownThreadId === userThread?.id
                  ? userThread.title
                  : (agentToAgent.find((thread) => thread.id === shownThreadId)?.title ??
                    created?.title ??
                    null)
              }
              onClosePane={() => dropListed(shownThreadId)}
            />
          ) : agentThreads === null ? (
            <p className={styles.note}>Loading…</p>
          ) : dmOff ? (
            <div className={styles.empty}>
              <p>Direct messages are turned off for {agent.name}.</p>
            </div>
          ) : (
            <div className={styles.empty}>
              <p>No direct messages with {agent.name} yet.</p>
              <Button
                variant="primary"
                size="sm"
                disabled={creating}
                onClick={() => void startConversation()}
              >
                Message {agent.name}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
