import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import type { SnagletAgent } from '@snaglet/shared/types';
import { Button, EmptyState } from '@desktop/components';
import { DmAvatar, PartyName, emitDmRead } from '@desktop/features/dms';
import {
  agentsApi,
  threadsApi,
  userProfileApi,
  type ThreadMessage,
  type ThreadParticipant,
} from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { getErrorMessage } from '@snaglet/shared/utils';
import { useElementWidth } from '@desktop/hooks/useElementWidth';
import { MessageList } from '../ChatView/MessageList/MessageList';
import type { MessageAuthor } from '../ChatView/MessageRow/MessageRow';
import { Composer } from '../ChatView/Composer/Composer';
import { ClarificationPrompt } from '../ChatView/ClarificationPrompt';
import { ToolConfirmationPrompt } from '../ChatView/ToolConfirmationPrompt';
import { CursorApprovalPrompts } from '../ChatView/CursorApprovalPrompt';
import { ClearThreadModal } from '../ChatView/ClearThreadModal/ClearThreadModal';
import { ForkThreadModal } from './ForkThreadModal';
import { showToast } from '@desktop/utils/toast';
import { requestOpenThread } from '@desktop/utils/openThread';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { ChatSettings, type ChatSettingsSection } from '../ChatView/settings/ChatSettings';
import { useSettingsPanelSize } from '../ChatView/useSettingsPanelSize';
import { useChatStream } from '../ChatView/hooks/useChatStream';
import type { RunActivity } from '../ChatView/hooks/types';
// The settings sidebar / drawer frame and its resize handles are ChatView's own.
import chatStyles from '../ChatView/ChatView.module.scss';
import styles from './DmView.module.scss';

interface DmViewProps {
  threadId: string;
  /** Pane title cache (the server's "A ↔ B"), shown until the parties load. */
  title?: string | null;
  /** Close the pane this view renders in (the conversation was deleted). */
  onClosePane?: () => void;
}

/**
 * A home thread's settings: its agent's per-thread settings (model, budget,
 * tool access, instructions, memories, summaries, compaction) only. No
 * context, routing, folder — and no Maintenance tab: a home thread keeps a
 * single party, so clearing lives on the header (Clear) and its history is
 * preserved instead by "Fork thread to workspace". With one section left,
 * ChatSettings renders no tab strip.
 */
const HOME_THREAD_SETTINGS: readonly ChatSettingsSection[] = ['agents'];

/** Pane width (px) below which settings open as a top drawer, as in ChatView. */
const NARROW_THRESHOLD = 520;

/** Newest message the server has stored (not an optimistic or streaming row). */
function newestStoredId(messages: readonly ThreadMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && !message.pending && !message.id.startsWith('streaming:')) return message.id;
  }
  return null;
}

function agentAuthor(agentId: string, agent: SnagletAgent | null): MessageAuthor {
  return {
    name: agent?.name ?? 'agent',
    avatar: (
      <DmAvatar
        party={{
          kind: 'agent',
          agentId,
          cursorSpec: agent?.cursorSpec ?? null,
          avatarUrl: agent?.avatarUrl ?? null,
        }}
      />
    ),
  };
}

/**
 * One direct-message conversation, read like a chat app (each bubble shows
 * its author's avatar and name) on top of the ordinary thread transcript,
 * stream and composer. The user's DM with an agent is its "home thread" and
 * sends through the normal chat path, so the agent answers; it also has
 * Settings (ChatView's panel narrowed to the Agents tab). An agent-to-agent
 * DM ("A ↔ B") is read-only for the user.
 *
 * The open pane keeps the thread marked read. With the agent's DMs off the
 * composer gives way to a note. A home thread has Clear (it permanently
 * deletes the messages) but no Delete; an agent-to-agent DM can be deleted
 * whole. Fork first copies a home thread into a workspace thread. The pane
 * closes when the thread is deleted anywhere.
 */
export const DmView: FC<DmViewProps> = ({ threadId, title = null, onClosePane }) => {
  const {
    messages,
    activities,
    memoryExtractions,
    ready,
    loading,
    historyError,
    retryHistory,
    working,
    participantAgentIds,
    sendMessage,
    stopGeneration,
    pendingClarification,
    respondToClarification,
    pendingToolConfirmations,
    respondToToolConfirmation,
    hasMoreOlder,
    hasMoreNewer,
    paginating,
    pageError,
    loadOlder,
    loadNewer,
    lastSendError,
    clearSendError,
  } = useChatStream(threadId);

  const [participants, setParticipants] = useState<ThreadParticipant[] | null>(null);
  const [participantsError, setParticipantsError] = useState<string | null>(null);
  const [agents, setAgents] = useState<ReadonlyMap<string, SnagletAgent>>(() => new Map());
  // Settled either way: the composer waits for it, so DMs off never flashes one.
  const [agentsSettled, setAgentsSettled] = useState(false);
  const [userName, setUserName] = useState('You');

  useEffect(() => {
    let canceled = false;
    threadsApi.listParticipants(threadId).then(
      (rows) => {
        if (!canceled) setParticipants(rows);
      },
      (err: unknown) => {
        if (!canceled) setParticipantsError(getErrorMessage(err));
      }
    );
    return () => {
      canceled = true;
    };
  }, [threadId]);

  useEffect(() => {
    let canceled = false;
    // Archived agents too: their DMs still name and draw them.
    agentsApi
      .list({ includeArchived: true })
      .then(
        (rows) => {
          if (!canceled) setAgents(new Map(rows.map((agent) => [agent.id, agent])));
        },
        (err: unknown) => console.error('DmView: failed to load agents', getErrorMessage(err))
      )
      .finally(() => {
        if (!canceled) setAgentsSettled(true);
      });
    userProfileApi.get().then(
      (profile) => {
        if (!canceled && profile.name.trim()) setUserName(profile.name.trim());
      },
      (err: unknown) => console.error('DmView: failed to load the user', getErrorMessage(err))
    );
    return () => {
      canceled = true;
    };
  }, []);

  const userIsParty = participants?.some((p) => p.kind === 'user') ?? false;
  // Only an agent-to-agent DM offers Delete. A home thread has Clear (it
  // permanently deletes the messages) and nothing more; while the parties are
  // unknown neither shows, so Delete never flashes on a home thread.
  const deletable = participants != null && !userIsParty;
  const agentIds = useMemo(() => {
    const fromParticipants = (participants ?? [])
      .filter((p) => p.kind === 'agent' && p.agentId)
      .map((p) => p.agentId);
    return fromParticipants.length > 0 ? fromParticipants : participantAgentIds;
  }, [participants, participantAgentIds]);

  const agentNameById = useMemo(
    () => new Map([...agents.values()].map((agent) => [agent.id, agent.name])),
    [agents]
  );

  // One stable author object per party: message rows are memoized on it.
  const userAuthor = useMemo<MessageAuthor>(
    () => ({ name: userName, label: <PartyName name={userName} isYou /> }),
    [userName]
  );
  const knownAuthors = useMemo(
    () => new Map([...agents.values()].map((agent) => [agent.id, agentAuthor(agent.id, agent)])),
    [agents]
  );
  // Authors no roster lists (a deleted agent's messages, shown as the ghost's).
  const otherAuthors = useRef(new Map<string, MessageAuthor>());
  const authorFor = useCallback(
    (row: { message?: ThreadMessage; activity?: RunActivity }): MessageAuthor | null => {
      if (row.message?.role === 'user') return userAuthor;
      const agentId = row.activity?.agentId ?? row.message?.agentId ?? null;
      if (!agentId) return null;
      const known = knownAuthors.get(agentId);
      if (known) return known;
      let other = otherAuthors.current.get(agentId);
      if (!other) {
        other = agentAuthor(agentId, null);
        otherAuthors.current.set(agentId, other);
      }
      return other;
    },
    [knownAuthors, userAuthor]
  );

  // Read once the history is in, then once per newly stored message: only
  // when the user is a party (agent-to-agent DMs hold no user cursor). Each
  // read refreshes the DMs list, so a re-render or a history reload with
  // nothing new stored sends nothing.
  const newestId = newestStoredId(messages);
  const markedThrough = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (loading || !userIsParty) return;
    if (markedThrough.current === newestId) return;
    markedThrough.current = newestId;
    threadsApi
      .markDmRead(threadId)
      .then(() => emitDmRead(threadId))
      .catch((err: unknown) => {
        console.error('DmView: failed to mark the DM read', getErrorMessage(err));
      });
  }, [threadId, newestId, loading, userIsParty]);

  // Deleted here or elsewhere: the pane goes, once.
  const [gone, setGone] = useState(false);
  const closedRef = useRef(false);
  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    setGone(true);
    onClosePane?.();
  }, [onClosePane]);
  useEffect(
    () =>
      onLibraryEvent((event) => {
        if (event.type === 'deleted' && event.kind === 'thread' && event.id === threadId) close();
      }),
    [threadId, close]
  );

  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const deleteConversation = async () => {
    setDeleting(true);
    setActionError(null);
    try {
      await threadsApi.delete(threadId);
      close();
    } catch (err) {
      setActionError(`Couldn’t delete the conversation: ${getErrorMessage(err)}`);
      setDeleting(false);
    }
  };

  // Prefer the app's own pane navigation when DmView is mounted inside the
  // Dashboard; fall back to the global open-thread bus otherwise (e.g. an
  // isolated test render with no provider).
  const nav = useDashboardNavigation();
  const openThreadInPane = useCallback(
    (id: string, titleHint?: string | null) => {
      if (nav?.openThread) nav.openThread(id, titleHint);
      else requestOpenThread(id, titleHint);
    },
    [nav]
  );

  // Settings, for a home thread only.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const showSettings = settingsOpen && userIsParty;
  const [showClear, setShowClear] = useState(false);
  const [showFork, setShowFork] = useState(false);
  // Fork needs history to copy. The server refuses an empty thread too; this
  // just keeps the button honest while the page is loaded.
  const hasMessages = !loading && messages.length > 0;
  const shellRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(shellRef);
  const isNarrow = paneWidth !== null && paneWidth < NARROW_THRESHOLD;
  const { drawerStyle, sidebarStyle, drawerHandle, sidebarHandle } = useSettingsPanelSize(shellRef);

  if (gone) {
    return (
      <div className={styles.shell}>
        <EmptyState
          title="Conversation deleted"
          body={userIsParty ? 'This home thread was deleted.' : 'This DM conversation was deleted.'}
        />
      </div>
    );
  }

  const agentNames = agentIds.map((id) => agentNameById.get(id) ?? 'agent');
  const homeThreadTitle = `${agentNames.join(', ')} · Home thread`;
  // Prefilled fork title, e.g. "Sprout · Home thread · Nov 6".
  const forkDefaultTitle = `${homeThreadTitle} · ${new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}`;
  // The user's own DM is the agent's home thread; a DM between two agents
  // names both.
  const heading: ReactNode =
    participants && agentNames.length > 0
      ? userIsParty
        ? homeThreadTitle
        : agentNames.map((name, i) => (
            <Fragment key={i}>
              {i > 0 ? ' ↔ ' : null}
              {name}
            </Fragment>
          ))
      : title;
  const settingsPanel = showSettings ? (
    <ChatSettings
      threadId={threadId}
      sections={HOME_THREAD_SETTINGS}
      fixedParticipants
      participantAgentIds={agentIds}
      onClear={() => setShowClear(true)}
    />
  ) : null;
  const replyTo = agentIds[0] ? (agentNameById.get(agentIds[0]) ?? 'the agent') : 'the agent';
  // The other party turned DMs off: the history stays, sending stops.
  const dmsOffFor = userIsParty
    ? agentIds.map((id) => agents.get(id)).find((agent) => agent?.dmEnabled === false)
    : undefined;
  const placeholder = loading
    ? 'Loading…'
    : historyError
      ? 'Couldn’t load this conversation'
      : !ready
        ? 'Connecting…'
        : `Message ${replyTo}`;

  return (
    <div ref={shellRef} className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.parties} aria-hidden>
          {agentIds.map((id) => {
            const agent = agents.get(id);
            return (
              <DmAvatar
                key={id}
                size={24}
                party={{
                  kind: 'agent',
                  agentId: id,
                  cursorSpec: agent?.cursorSpec ?? null,
                  avatarUrl: agent?.avatarUrl ?? null,
                }}
              />
            );
          })}
        </span>
        <h2 className={styles.title}>{heading || 'Direct messages'}</h2>
        <span className={styles.actions}>
          {userIsParty && (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={showSettings}
              aria-label="Home thread settings"
              title="Agent settings for this home thread"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              Settings
            </Button>
          )}
          {userIsParty && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Fork thread to workspace"
              disabled={!hasMessages || working}
              title={
                working
                  ? 'The agent is replying — wait for it to finish, then fork'
                  : hasMessages
                    ? 'Copy this conversation’s history into a new workspace thread'
                    : 'Nothing to fork — this thread has no messages yet'
              }
              onClick={() => setShowFork(true)}
            >
              <span className={styles.forkLabelLong}>Fork thread to workspace</span>
              <span className={styles.forkLabelShort} aria-hidden>
                Fork
              </span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            title="Remove every message from this conversation"
            onClick={() => setShowClear(true)}
          >
            Clear
          </Button>
          {deletable && (
            <Button
              variant="ghost"
              size="sm"
              className={styles.deleteButton}
              aria-label="Delete conversation"
              title="Delete this whole conversation; the next DM starts a new one"
              disabled={deleting}
              onClick={() => void deleteConversation()}
            >
              Delete
            </Button>
          )}
        </span>
      </header>

      {actionError && (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      )}
      {participantsError && (
        <p className={styles.error} role="alert">
          Couldn’t load who is in this conversation: {participantsError}
        </p>
      )}

      {/* Narrow pane: settings drop down over the top of the chat. */}
      {settingsPanel && isNarrow && (
        <div className={chatStyles.topDrawer} style={drawerStyle} data-testid="dm-settings">
          {settingsPanel}
          <div
            className={chatStyles.drawerResizeHandle}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize settings panel"
            {...drawerHandle}
          />
        </div>
      )}

      <div className={styles.body}>
        <div className={styles.main}>
          <div className={styles.chat}>
            <MessageList
              messages={messages}
              activities={activities}
              agentNameById={agentNameById}
              loading={loading}
              failed={historyError !== null}
              renderMode="md"
              hasMoreOlder={hasMoreOlder}
              hasMoreNewer={hasMoreNewer}
              paginating={paginating}
              pageError={pageError}
              onLoadOlder={loadOlder}
              onLoadNewer={loadNewer}
              memoryExtractions={memoryExtractions}
              authorFor={authorFor}
            />
            {!loading && historyError && (
              <EmptyState
                layout="inline"
                role="alert"
                title="Couldn’t load this conversation"
                body={historyError}
                action={
                  <Button variant="neutral" size="sm" onClick={retryHistory}>
                    Retry
                  </Button>
                }
              />
            )}
            {pendingClarification && (
              <ClarificationPrompt
                key={pendingClarification.callId}
                request={pendingClarification}
                onRespond={respondToClarification}
              />
            )}
            {pendingToolConfirmations.map((request) => (
              <ToolConfirmationPrompt
                key={request.callId}
                request={request}
                agentName={request.agentId ? agentNameById.get(request.agentId) : undefined}
                onRespond={respondToToolConfirmation}
              />
            ))}
            <CursorApprovalPrompts />
            {userIsParty && dmsOffFor ? (
              <p className={styles.readOnly}>DMs are off for {dmsOffFor.name}.</p>
            ) : userIsParty && agentsSettled ? (
              <Composer
                placeholder={placeholder}
                threadId={threadId}
                onSubmit={ready ? sendMessage : undefined}
                working={working}
                onStop={stopGeneration}
                restoreText={lastSendError?.text ?? null}
                onRestored={clearSendError}
              />
            ) : participants && !userIsParty ? (
              <p className={styles.readOnly}>
                Read only: a conversation between two agents. You can read or delete it.
              </p>
            ) : null}
          </div>
        </div>

        {/* Wide pane: settings beside the chat, resizable from their left edge. */}
        {settingsPanel && !isNarrow && (
          <div
            className={chatStyles.settingsSidebar}
            style={sidebarStyle}
            data-testid="dm-settings"
          >
            <div
              className={chatStyles.sidebarResizeHandle}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize settings panel"
              {...sidebarHandle}
            />
            {settingsPanel}
          </div>
        )}
      </div>

      {showFork && (
        <ForkThreadModal
          threadId={threadId}
          defaultTitle={forkDefaultTitle}
          onClose={() => setShowFork(false)}
          onForked={(thread) => {
            // The tree already learns about the new thread from the server's
            // realtime create event; the toast gives a one-click way in.
            showToast('Forked to workspace', {
              action: {
                label: 'Open thread',
                run: () => openThreadInPane(thread.id, thread.title),
              },
            });
          }}
        />
      )}
      {showClear && (
        <ClearThreadModal
          threadId={threadId}
          threadTitle={homeThreadTitle}
          onClose={() => setShowClear(false)}
        />
      )}
    </div>
  );
};
