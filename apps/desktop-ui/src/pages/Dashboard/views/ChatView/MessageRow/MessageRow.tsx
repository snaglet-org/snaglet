import {
  CONVERSATION_STOP_CONTINUABLE,
  CONVERSATION_STOP_REASON_COPY,
  SHELL_JOB_LINE_PREFIX,
} from '@snaglet/shared/types';
import { memo, useCallback, useEffect, useState, type FC, type ReactNode } from 'react';
import type { ThreadMessage } from '@desktop/utils/api';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer';
import { toggleMarkdownCheckbox } from '@desktop/utils/toggleMarkdownCheckbox';
import { threadsApi } from '@desktop/utils/api/threads';
import { showToast } from '@desktop/utils/toast';
import { formatClockTime, getErrorMessage } from '@snaglet/shared/utils';
import { GHOST_HOOK_LABEL, resolveAuthorLabel } from '@snaglet/shared/constants/systemAgents';
import { Button } from '@desktop/components';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import type { RenderMode } from '../ChatView';
import type { RunActivity } from '../hooks/types';
import { chatRenderOffsetToSource, markdownForChatMessageRender } from '../chatMarkdown';
import { SubagentResultLine } from '../Subagents/SubagentResultLine';
import { ActivityDisclosure } from './ActivityDisclosure';
import { BubbleActions } from './BubbleActions';
import { threadStartedLabel } from './threadStartedLabel';
import styles from './MessageRow.module.scss';

/** "8:33 PM" for today's messages, "Jun 28 8:33 PM" for older ones; null when unparseable. */
function formatMessageTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = formatClockTime(date);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return time;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

function runErrorTitle(kind: NonNullable<ThreadMessage['runError']>['kind']): string {
  switch (kind) {
    case 'timeout':
      return 'Response timed out';
    case 'model_failure':
      return 'Model error';
    case 'rate_limit':
      return 'Rate limited';
    case 'aborted':
      return 'Run aborted';
    case 'no_model':
      return 'No model configured';
    case 'output_limit':
      return 'Reply cut off';
    case 'runtime':
    default:
      return 'Run failed';
  }
}

/**
 * "Configure model" on a no-model failure: opens the agent's page on its
 * Overview tab, where the model is set. A rendering without the dashboard's
 * navigation (a preview, an export) shows the card's text alone. Its own
 * component, so only these cards follow the navigation context.
 */
const ConfigureModelLink: FC<{ agentId: string }> = ({ agentId }) => {
  const openAgentById = useDashboardNavigation()?.openAgentById;
  if (!openAgentById) return null;
  return (
    <Button
      variant="link"
      size="sm"
      className={styles.runErrorAction}
      onClick={() => openAgentById(agentId, { tab: 'overview' })}
    >
      Configure model
    </Button>
  );
};

/**
 * Who wrote a row, for surfaces that show an avatar beside each bubble (the
 * DM reading pane). Pass one stable object per author: rows are memoized.
 */
export interface MessageAuthor {
  name: string;
  /** Absent for a party that shows no avatar (the signed-in person). */
  avatar?: ReactNode;
  /** Shown in a user bubble's header in place of `name`. */
  label?: ReactNode;
}

interface MessageRowProps {
  /** The persisted/streaming message. Optional when rendering a stub row
   *  for an in-flight run that has only emitted activity (no delta yet). */
  message?: ThreadMessage;
  /** The run's activity (thinking + tool steps), if any.
   *  Rendered as a collapsible disclosure inside the bubble. */
  activity?: RunActivity;
  agentNameById: Map<string, string>;
  renderMode: RenderMode;
  /**
   * When set, the avatar sits beside the bubble (outside, on the bubble's
   * own side) and a user bubble names its author too. Absent in ordinary
   * threads.
   */
  author?: MessageAuthor | null;
  /** Small avatar drawn inside an agent bubble's name tag (ordinary threads). */
  tagAvatarFor?: (agentId: string) => ReactNode;
}

/** The avatar column beside a bubble. */
const AuthorAvatar: FC<{ author: MessageAuthor }> = ({ author }) => (
  <span className={styles.authorAvatar} data-tid="authorAvatar">
    {author.avatar}
  </span>
);

/**
 * Renders one chat row as a PictoChat-style bubble. Branches by role:
 *   user      → right-aligned bubble, brand-tinted
 *   assistant → left-aligned bubble with `[agent]` tag and optional
 *               inline activity disclosure under the body
 *   other     → centered dim meta line
 *
 * The activity widget folds into the bubble: open for live runs, closed for
 * complete ones.
 */
const MessageRowImpl: FC<MessageRowProps> = ({
  message,
  activity,
  agentNameById,
  renderMode,
  author = null,
  tagAvatarFor,
}) => {
  // A ticked checkbox shows at once and saves in the background; it is
  // reverted, and the failure said, when the save does not go through.
  const [localContent, setLocalContent] = useState<string | null>(null);
  // Saves started from this row that have not settled yet.
  const [savesInFlight, setSavesInFlight] = useState(0);

  const handleCheckboxToggle = useCallback(
    (sourceOffset: number) => {
      if (!message) return;
      const base = localContent ?? message.content;
      const updated = toggleMarkdownCheckbox(base, sourceOffset);
      if (updated === base) return;
      setLocalContent(updated);
      setSavesInFlight((n) => n + 1);
      threadsApi
        .updateMessageContent(message.threadId, message.id, updated)
        .catch((err: unknown) => {
          setLocalContent(null);
          showToast(`Couldn’t save the checkbox: ${getErrorMessage(err)}`, { durationMs: 6000 });
        })
        .finally(() => setSavesInFlight((n) => n - 1));
    },
    [message, localContent]
  );
  // A save comes back to every viewer, this row included, as
  // socket:chat:message_updated. Once every save has settled and the message
  // holds what this row shows, drop the local copy so a later edit from
  // another view is not hidden behind it. Waiting for the saves keeps an
  // earlier tick's echo from flashing over a newer one.
  const messageContent = message?.content;
  useEffect(() => {
    if (savesInFlight === 0 && localContent !== null && localContent === messageContent) {
      setLocalContent(null);
    }
  }, [savesInFlight, localContent, messageContent]);
  // A user bubble renders its chat-newline form, with hard-break spaces
  // added, so the renderer's offsets point into that text, not the stored one.
  const handleUserCheckboxToggle = useCallback(
    (renderedOffset: number) => {
      const base = localContent ?? message?.content ?? '';
      handleCheckboxToggle(chatRenderOffsetToSource(base, renderedOffset));
    },
    [handleCheckboxToggle, localContent, message]
  );

  if (!message && !activity) return null;

  // Stored outbound-linter correction rows (role='user' with linter
  // attribution metadata) are not something the human typed, so they render
  // nothing. The row stays in history; replay still delivers it to the
  // targeted agent.
  if (
    message?.role === 'user' &&
    message.linterTargetAgentId &&
    message.fabricatedIds &&
    message.fabricatedIds.length > 0
  ) {
    return null;
  }

  // thread_event rows (roster, dispatch mode, "thread started") are persisted
  // as role='user' but are not something the human typed: they render as a
  // centered meta line. This branch runs before the user-bubble branch.
  if (message?.messageType === 'thread_event') {
    // A subagent helper's result, addressed to its orchestrator: one line
    // that opens into the report (metadata on reload, `subagent` live).
    if (message.subagentResult) {
      return (
        <SubagentResultLine
          message={message}
          result={message.subagentResult}
          renderMode={renderMode}
        />
      );
    }
    // A background shell job's end row: its headline, opening into the tail
    // of the command's output (matched on the server's stable prefix, so
    // live frames and history rows render alike).
    const newline = message.content.indexOf('\n');
    if (message.content.startsWith(SHELL_JOB_LINE_PREFIX) && newline > 0) {
      return (
        <details
          className={`${styles.meta} ${styles.shellJob}`}
          data-message-id={message.id}
          data-tid="shellJobRow"
        >
          <summary>{message.content.slice(0, newline)}</summary>
          <pre className={styles.shellJobDetail}>{message.content.slice(newline + 1)}</pre>
        </details>
      );
    }
    // The opening line names its routing mode for agents; people see a quiet
    // divider with who the thread started with.
    const threadStarted = threadStartedLabel(message.content);
    if (threadStarted) {
      return (
        <div
          className={`${styles.meta} ${styles.threadStarted}`}
          data-message-id={message.id}
          data-tid="threadEventRow"
          data-event="thread-started"
        >
          <span>{threadStarted}</span>
        </div>
      );
    }
    // Conversation-ending narration gets an affordance hint when sending a
    // new message simply continues with a fresh budget (wave/token/tool
    // limits). Matched on the server's stable copy strings (the shared
    // CONVERSATION_STOP_REASON_COPY map) so live frames and history rows
    // render identically without needing the metadata payload.
    const isConversationEnded = message.content.startsWith('[conversation ended');
    const isContinuable =
      isConversationEnded &&
      [...CONVERSATION_STOP_CONTINUABLE].some((reason) =>
        message.content.includes(CONVERSATION_STOP_REASON_COPY[reason])
      );
    return (
      <div
        className={[styles.meta, isConversationEnded ? styles.conversationEnded : '']
          .filter(Boolean)
          .join(' ')}
        data-message-id={message.id}
        data-tid={isConversationEnded ? 'conversationEndedRow' : 'threadEventRow'}
      >
        {message.content}
        {isContinuable && (
          <span className={styles.continueHint} data-tid="continueHint">
            send a message to continue
          </span>
        )}
      </div>
    );
  }

  // User messages render their own bubble shape and never carry an activity.
  if (message?.role === 'user') {
    const body =
      renderMode === 'md' ? (
        <MarkdownRenderer
          content={markdownForChatMessageRender(localContent ?? message.content)}
          className={`${styles.markdownBody} snaglet-message-find-text`}
          showIncludeToggle={false}
          onCheckboxToggle={handleUserCheckboxToggle}
        />
      ) : (
        <div className={`${styles.rawBody} snaglet-message-find-text`}>
          {localContent ?? message.content}
        </div>
      );
    // Same format as the agent bubble's header; hidden while the optimistic
    // send is still pending (its time isn't the persisted one yet).
    const userTimestamp = message.pending ? null : formatMessageTime(message.createdAt);
    return (
      <div
        className={`${styles.row} ${styles.userRow}${author ? ` ${styles.withAuthor}` : ''}`}
        data-message-id={message.id}
        data-tid="userRow"
      >
        <div
          className={`${styles.bubble} ${styles.userBubble}${message.pending ? ` ${styles.pendingBubble}` : ''}`}
          data-tid="userBubble"
          data-pending={message.pending ? 'true' : undefined}
        >
          {message.externalSender ? <strong>{message.externalSender.name}</strong> : null}
          {!message.externalSender && message.externalSenderLabel ? (
            <strong>{message.externalSenderLabel}</strong>
          ) : null}
          {userTimestamp || author ? (
            <div className={`${styles.bubbleHeader} ${styles.bubbleHeaderEnd}`}>
              {author ? (
                <span className={styles.agentTag}>{author.label ?? author.name}</span>
              ) : null}
              {userTimestamp ? <span className={styles.timestamp}>{userTimestamp}</span> : null}
            </div>
          ) : null}
          {body}
          <div className={`${styles.bubbleFooter} ${styles.bubbleFooterEnd}`}>
            {message.pending ? <span className={styles.pendingHint}>sending…</span> : null}
            <BubbleActions
              messageId={message.id}
              content={localContent ?? message.content}
              agentId={message.agentId}
            />
          </div>
        </div>
        {author?.avatar ? <AuthorAvatar author={author} /> : null}
      </div>
    );
  }

  // System / other non-assistant roles render as a centered meta line.
  if (message && message.role !== 'assistant') {
    return (
      <div className={styles.meta} data-message-id={message.id}>
        {message.content}
      </div>
    );
  }

  // Run-failure message, persisted by the server when an agent run died
  // mid-stream: a centered error bubble, so it doesn't look like a normal
  // reply. The body is a one-liner from `summarizeError()`; the heading comes
  // from the structured metadata.
  if (message?.role === 'assistant' && message.runError) {
    const re = message.runError;
    const name =
      re.agentName ??
      (message.agentId ? (agentNameById.get(message.agentId) ?? message.agentId) : 'agent');
    const modelTag = re.provider && re.modelId ? ` · ${re.provider}/${re.modelId}` : '';
    return (
      <div
        className={`${styles.row} ${styles.runErrorRow}`}
        data-message-id={message.id}
        data-run-error-kind={re.kind}
      >
        <div className={styles.runErrorBubble} role="status">
          <div className={styles.runErrorHeader}>
            <span className={styles.runErrorIcon} aria-hidden>
              ⚠
            </span>
            <span className={styles.runErrorTitle}>
              {name} — {runErrorTitle(re.kind)}
              <span className={styles.runErrorMeta}>{modelTag}</span>
            </span>
          </div>
          <div className={styles.runErrorSummary}>{re.summary}</div>
          {/* The link shares the footer row with the hover actions, so the
              card ends right under it. */}
          <div className={`${styles.bubbleFooter} ${styles.bubbleFooterEnd}`}>
            {re.kind === 'no_model' && message.agentId ? (
              <ConfigureModelLink agentId={message.agentId} />
            ) : null}
            <BubbleActions messageId={message.id} content={re.summary} agentId={message.agentId} />
          </div>
        </div>
      </div>
    );
  }

  // Assistant bubble, for a stub (live run, no message yet) and a full row
  // alike. The child shape stays the same either way so React keeps the
  // `<ActivityDisclosure>` mounted while the streaming projection drops out
  // between tool calls; otherwise the disclosure would remount and flicker.
  const isStreaming = !!message && message.id.startsWith('streaming:');
  const authorAgentId = activity?.agentId ?? message?.agentId;
  // The ghost system actor reads "system" for its own posts (hook notices); a
  // deleted agent's message held by ghost keeps whatever it showed before.
  const agentName = resolveAuthorLabel({
    agentId: authorAgentId,
    fallbackName: (authorAgentId ? agentNameById.get(authorAgentId) : null) ?? author?.name ?? null,
    originalAgentName: message?.originalAgentName,
  });
  const timestamp = !isStreaming && message ? formatMessageTime(message.createdAt) : null;

  const body = !message ? null : isStreaming ? (
    <div className={styles.transient}>
      <span className={styles.transientLabel}>thinking…</span>
      <span className={styles.transientText}>{message.content}</span>
    </div>
  ) : renderMode === 'md' ? (
    <MarkdownRenderer
      content={localContent ?? message.content}
      className={`${styles.markdownBody} snaglet-message-find-text`}
      showIncludeToggle={false}
      onCheckboxToggle={handleCheckboxToggle}
    />
  ) : (
    <div className={`${styles.rawBody} snaglet-message-find-text`}>
      {localContent ?? message.content}
    </div>
  );

  const showActions = !!message && !isStreaming;

  return (
    <div
      className={`${styles.row} ${styles.agentRow}${author ? ` ${styles.withAuthor}` : ''}`}
      data-message-id={message?.id ?? undefined}
    >
      {author?.avatar ? <AuthorAvatar author={author} /> : null}
      <div className={`${styles.bubble} ${styles.agentBubble}`}>
        {agentName || timestamp ? (
          <div className={styles.bubbleHeader}>
            {agentName ? (
              <span
                className={
                  agentName === GHOST_HOOK_LABEL
                    ? `${styles.agentTag} ${styles.systemTag}`
                    : styles.agentTag
                }
              >
                {authorAgentId && tagAvatarFor && agentName !== GHOST_HOOK_LABEL ? (
                  <span className={styles.tagAvatar} data-tid="tagAvatar" aria-hidden>
                    {tagAvatarFor(authorAgentId)}
                  </span>
                ) : null}
                {agentName.toLowerCase()}
              </span>
            ) : null}
            {timestamp ? <span className={styles.timestamp}>{timestamp}</span> : null}
          </div>
        ) : null}
        {body}
        {showActions && (
          <div className={styles.bubbleFooter}>
            <BubbleActions
              messageId={message.id}
              content={localContent ?? message.content}
              agentId={message.agentId}
            />
          </div>
        )}
        {activity ? (
          <ActivityDisclosure
            key={`activity:${activity.runId}`}
            activity={activity}
            agentName={agentName}
          />
        ) : null}
      </div>
    </div>
  );
};

/**
 * Memoized export. Messages and activities keep their identity across
 * useChatStream updates unless they change, so a live run re-renders one row,
 * not every bubble on screen.
 */
export const MessageRow = memo(MessageRowImpl);
