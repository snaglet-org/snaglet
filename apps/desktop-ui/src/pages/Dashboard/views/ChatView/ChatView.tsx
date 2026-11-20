import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import type { ThreadTrimApplyResult } from '@snaglet/shared/types';
import { Button, EmptyState } from '@desktop/components';
import { useConversationFind } from '@desktop/features/pane-find/useConversationFind';
import { StatusStrip } from './StatusStrip/StatusStrip';
import { MessageList } from './MessageList/MessageList';
import { FlowerAvatar } from '@desktop/components/agentCursor/FlowerAvatar';
import { useAgentSpecs } from '@desktop/components/agentCursor/useAgentSpecs';
import { Composer } from './Composer/Composer';
import { ClarificationPrompt } from './ClarificationPrompt';
import { ToolConfirmationPrompt } from './ToolConfirmationPrompt';
import { AgentStatusBubbles } from './AgentStatusBubbles/AgentStatusBubbles';
import { ClearThreadModal } from './ClearThreadModal/ClearThreadModal';
import { DispatchHint } from './DispatchHint/DispatchHint';
import { ChatSettings } from './settings/ChatSettings';
import { TrimPanel, useThreadTrim, useTrimOverlay, useTrimTotalsLabel } from './TrimPanel';
import { useChatStream } from './hooks/useChatStream';
import { useAgentNames } from './hooks/useAgentNames';
import { useSettingsPanelSize } from './useSettingsPanelSize';
import { threadTextSizeStyle, useThreadTextSize } from './threadTextSize';
import { useElementWidth } from '@desktop/hooks/useElementWidth';
import { ExportButton } from '@desktop/components/ExportButton';
import { usePaneChromeActions } from '../../chrome/PaneChrome/PaneChrome';
import { useClaimOpenInSidebar } from '../../chrome/PaneChrome/openInSidebar';
import type { DetailSelection } from '../../selection/types';
import {
  SubagentNavigationContext,
  SubagentRemovedState,
  SubagentStrip,
  SubagentThreadHeader,
  useChatSubagents,
  useHelperStop,
} from './Subagents';
import {
  AgentPillsRow,
  ThreadMessagingProvider,
  VoiceComposerDock,
  VoiceModeToggle,
  VoiceToggle,
} from '@desktop/features/voice';
import {
  VisionComposerControl,
  VisionPreviewPanel,
  VisionSessionProvider,
  VisionTransientCaptureCards,
} from '@desktop/features/vision';
import { CursorApprovalPrompts } from './CursorApprovalPrompt';
import { ProviderNotice, ThreadStarter } from '@desktop/features/onboarding';
import styles from './ChatView.module.scss';

interface ChatViewProps {
  threadId: string;
  threadTitle: string | null;
  /**
   * When set, the settings panel opens with this agent preselected.
   * Driven by the WorkspaceTree's per-thread "Agents" leaf.
   */
  focusAgentId?: string | null;
  /** Sub-focus inside the per-agent context rail (see ChatSettings). */
  focusMemoryId?: string | null;
  focusSummaryId?: string | null;
  /**
   * Open the chat at this specific message — the history loads a window
   * centered on the message instead of the most recent page, and the
   * message list holds that row in view, highlighted, until the user scrolls.
   */
  focusMessageId?: string | null;
  /** Distinguishes one message-focus navigation from the next (see DetailSelection). */
  focusRequestId?: number | null;
  /**
   * Swap this pane's selection (pushing pane history, so Back returns here).
   * Subagent chips and result lines open a helper's thread through it, and a
   * helper's thread links back to its parent. Absent in previews.
   */
  onReplaceSelection?: (selection: DetailSelection) => void;
  /** The selection's subagent-helper marker: the thread that started this one. */
  helperParentThreadId?: string | null;
}

export type RenderMode = 'md' | 'raw';

/** Width (px) below which settings shifts from sidebar → top drawer. */
const NARROW_THRESHOLD = 520;
const RENDER_MODE_KEY = 'snaglet.dashboard.chat.renderMode';

/**
 * ChatView — chat surface for the Dashboard pane.
 *
 * Settings open beside the chat rather than replacing it:
 *   - a right-hand sidebar (pane width ≥ NARROW_THRESHOLD)
 *   - a top drawer that pushes the chat down (pane width < NARROW_THRESHOLD)
 */
export const ChatView: FC<ChatViewProps> = ({
  threadId,
  threadTitle = null,
  focusAgentId = null,
  focusMemoryId = null,
  focusSummaryId = null,
  focusMessageId = null,
  focusRequestId = null,
  onReplaceSelection,
  helperParentThreadId = null,
}) => {
  const shellRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(shellRef);
  const isNarrow = paneWidth !== null && paneWidth < NARROW_THRESHOLD;

  const {
    messages,
    activities,
    agentStatuses,
    memoryExtractions,
    ready,
    loading,
    historyError,
    retryHistory,
    working,
    currentWave,
    participantCount,
    participantAgentIds,
    refetchParticipants,
    sendMessage,
    stopGeneration,
    stopAgentGeneration,
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
    initialFocusMessageId,
    initialFocusRequestId,
    initialFocusIsNavigation,
    dispatchHint,
    clearDispatchHint,
    lastSendError,
    clearSendError,
  } = useChatStream(threadId, { focusMessageId, focusRequestId });
  // A queued agent's next run has not started, so it is not counted as active.
  let activeAgentCount = 0;
  for (const status of agentStatuses.values()) if (status !== 'queued') activeAgentCount += 1;

  const conversationFind = useConversationFind(threadId, messages);

  // Subagent helpers: this thread's live helpers feed the composer
  // strip and the result lines; when this thread IS a helper's hidden
  // thread, `helper` names it and reports its removal.
  const {
    subagents,
    helper,
    navigation: subagentNavigation,
    openHelperThread,
    openParentThread,
  } = useChatSubagents(threadId, threadTitle, onReplaceSelection, helperParentThreadId);
  // In a helper's thread, Stop pauses the helper (kept, its orchestrator told).
  const { onStop, onStopAgent } = useHelperStop(helper, stopGeneration, stopAgentGeneration);

  // "Open in sidebar" sits at the top of the thread settings panel instead of
  // the pane topbar (ChatSettings renders it).
  useClaimOpenInSidebar();

  // Export writes the whole transcript. The id is kept in the suggested name
  // so exported threads stay collision-free and machine-resolvable, matching
  // what the server derives when no name is supplied.
  usePaneChromeActions(
    useMemo(
      () => (
        <ExportButton
          variant="topbar"
          kind="thread"
          id={threadId}
          suggestedName={`${threadTitle?.trim() || 'Untitled thread'} (${threadId}).md`}
        />
      ),
      [threadId, threadTitle]
    )
  );

  const hasAgents = participantCount > 0;
  const [showClear, setShowClear] = useState(false);
  const [lastTrimResult, setLastTrimResult] = useState<ThreadTrimApplyResult | null>(null);

  // Open settings automatically when the pane carries a deep-link focus.
  const wantsSettings = Boolean(focusAgentId || focusMemoryId || focusSummaryId);
  // A click on a memory-extraction notice: open that agent's memories in the
  // settings (proposals waiting on you are listed first). `n` makes a repeat
  // click on the same notice a new request.
  const [noticeFocus, setNoticeFocus] = useState<{ agentId: string; n: number } | null>(null);
  const openMemoryNotice = useCallback((agentId: string) => {
    setNoticeFocus((prev) => ({ agentId, n: (prev?.n ?? 0) + 1 }));
    setSettingsOpen(true);
  }, []);
  useEffect(() => setNoticeFocus(null), [threadId]);
  const [settingsOpen, setSettingsOpen] = useState(wantsSettings);
  useEffect(() => {
    setSettingsOpen(wantsSettings);
  }, [threadId, wantsSettings]);
  // Closing settings ends the request, so reopening them lands where the user left off.
  useEffect(() => {
    if (!settingsOpen) setNoticeFocus(null);
  }, [settingsOpen]);

  // Whether Settings → Maintenance is showing the Trim view. ChatSettings
  // hosts it (so the settings tabs stay usable) but the state lives here.
  const [trimActive, setTrimActive] = useState(false);
  useEffect(() => setTrimActive(false), [threadId]);
  useEffect(() => setLastTrimResult(null), [threadId]);
  const closeTrim = useCallback(() => setTrimActive(false), []);
  const trimTotals = useTrimTotalsLabel(threadId);

  // Trim state lives here, not in TrimPanel: the panel and the message list
  // must render the same resolved plan, or the dimming would disagree with
  // the figures. Passing '' while the panel is closed keeps the hook inert.
  const trimOpen = settingsOpen && trimActive;
  const trim = useThreadTrim(trimOpen ? threadId : '');
  const trimOverlay = useTrimOverlay(trim, trimOpen);

  const [renderMode, setRenderMode] = useState<RenderMode>(() => {
    try {
      return window.localStorage.getItem(RENDER_MODE_KEY) === 'raw' ? 'raw' : 'md';
    } catch {
      return 'md';
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(RENDER_MODE_KEY, renderMode);
    } catch {
      // Storage unavailable: the choice lasts for this view only.
    }
  }, [renderMode]);

  const { drawerStyle, sidebarStyle, drawerHandle, sidebarHandle } = useSettingsPanelSize(shellRef);

  // This thread's text size (Settings → General → Text size), applied to the
  // chat column only: messages and the composer, not the settings beside it.
  const textSize = useThreadTextSize(threadId);

  // Each agent bubble shows its flower beside the name, as the cursor overlay draws it.
  const { specFor } = useAgentSpecs();
  const tagAvatarFor = useCallback(
    (agentId: string) => (
      <FlowerAvatar spec={specFor(agentId)} emotion="neutral" size={16} animate={false} />
    ),
    [specFor]
  );

  const agentNameById = useAgentNames(
    participantAgentIds,
    helper?.subagent?.agentId ?? null,
    helper?.subagent?.name ?? null
  );

  // An empty thread offers things to ask; a pick fills the composer.
  const [fillRequest, setFillRequest] = useState<{ text: string; id: number } | null>(null);
  const pickSuggestion = useCallback(
    (text: string) => setFillRequest((prev) => ({ text, id: (prev?.id ?? 0) + 1 })),
    []
  );
  const agentNames = useMemo(
    () => participantAgentIds.map((id) => agentNameById.get(id) ?? id),
    [participantAgentIds, agentNameById]
  );
  const showStarter =
    !loading && !historyError && hasAgents && messages.length === 0 && helper === null;

  const composerPlaceholder = loading
    ? 'Loading…'
    : historyError
      ? 'Couldn’t load this conversation'
      : !hasAgents
        ? 'No agents in this thread — add one to start chatting'
        : !ready
          ? 'Connecting…'
          : 'Type a message';

  const settingsPanel = (
    <ChatSettings
      threadId={threadId}
      showOpenInSidebar
      trimSummary={trimTotals.summary}
      trimDetail={trimTotals.detail}
      trimError={trimTotals.error}
      trimResult={
        lastTrimResult
          ? 'Trimmed ' +
            lastTrimResult.removed.messages.toLocaleString() +
            ' messages; ' +
            lastTrimResult.remaining.messages.toLocaleString() +
            ' remain.'
          : null
      }
      onOpenTrim={() => {
        setTrimActive(true);
        setSettingsOpen(true);
      }}
      trimOpen={trimActive}
      onCloseTrim={closeTrim}
      trimPanel={
        <TrimPanel
          trim={trim}
          onCancel={closeTrim}
          onTrimmed={(result) => {
            // The Maintenance totals are stale by exactly the removed rows.
            trimTotals.refresh();
            refetchParticipants();
            setLastTrimResult(result);
            // Back to Maintenance, where the result is reported.
            setTrimActive(false);
          }}
        />
      }
      onClear={() => setShowClear(true)}
      participantAgentIds={participantAgentIds}
      focusAgentId={noticeFocus?.agentId ?? focusAgentId}
      focusMemoryId={focusMemoryId}
      focusSummaryId={focusSummaryId}
      memoryNoticeRequest={noticeFocus ? { n: noticeFocus.n } : null}
      helperThread={helper !== null}
      onAgentAdded={refetchParticipants}
      onAgentRemoved={refetchParticipants}
    />
  );

  // A removed helper's thread and messages are gone; say so instead of
  // leaving a dead transcript and a composer that cannot send.
  if (helper?.removed) {
    return (
      <div ref={shellRef} className={styles.shell}>
        <SubagentRemovedState onOpenParent={openParentThread} />
      </div>
    );
  }

  return (
    <ThreadMessagingProvider
      threadId={threadId}
      messages={messages}
      participantAgentIds={participantAgentIds}
      agentNameById={agentNameById}
    >
      <div
        ref={shellRef}
        className={[
          styles.shell,
          settingsOpen ? styles.settingsOpen : '',
          isNarrow ? styles.narrow : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className={styles.frame}>
          {conversationFind.bar}
          {/* StatusStrip always visible — floats above the drawer in narrow mode */}
          <StatusStrip
            renderMode={renderMode}
            onRenderModeChange={setRenderMode}
            settingsOpen={settingsOpen}
            onToggleSettings={() => {
              // Closing Settings also leaves Trim, so reopening never lands
              // on a half-finished cut.
              if (settingsOpen) setTrimActive(false);
              setSettingsOpen(!settingsOpen);
            }}
            waveLabel={
              working && currentWave !== null
                ? `wave ${currentWave} · ${activeAgentCount} active`
                : null
            }
          />
          {helper && (
            <SubagentThreadHeader
              threadId={threadId}
              helper={helper}
              onOpenParent={openParentThread}
            />
          )}

          {/* Narrow mode: top drawer inside the frame, below StatusStrip */}
          {isNarrow && settingsOpen && (
            <div className={styles.topDrawer} style={drawerStyle}>
              {settingsPanel}
              <div
                className={styles.drawerResizeHandle}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize settings panel"
                {...drawerHandle}
              />
            </div>
          )}

          <div className={styles.body}>
            <div className={styles.chat} style={threadTextSizeStyle(textSize)}>
              {hasAgents && helper === null && (
                <ProviderNotice
                  agentNames={agentNames}
                  onConnect={() => onReplaceSelection?.({ kind: 'get-started' })}
                />
              )}
              <SubagentNavigationContext.Provider value={subagentNavigation}>
                <MessageList
                  messages={conversationFind.displayedMessages}
                  find={conversationFind.target}
                  activities={activities}
                  agentNameById={agentNameById}
                  tagAvatarFor={tagAvatarFor}
                  loading={loading}
                  failed={historyError !== null}
                  hideEmptyNote={showStarter}
                  renderMode={renderMode}
                  hasMoreOlder={!conversationFind.open && hasMoreOlder}
                  hasMoreNewer={!conversationFind.open && hasMoreNewer}
                  paginating={paginating}
                  pageError={pageError}
                  onLoadOlder={loadOlder}
                  onLoadNewer={loadNewer}
                  focusMessageId={initialFocusMessageId}
                  focusRequestId={initialFocusRequestId}
                  holdFocus={initialFocusIsNavigation}
                  trim={trimOverlay}
                  memoryExtractions={memoryExtractions}
                  onOpenMemoryNotice={openMemoryNotice}
                />
              </SubagentNavigationContext.Provider>
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
              {showStarter && (
                <ThreadStarter
                  agentIds={participantAgentIds}
                  agentNames={agentNames}
                  onPick={pickSuggestion}
                />
              )}
              {!loading && !historyError && !hasAgents && (
                <EmptyState
                  layout="inline"
                  title="No agents in this thread"
                  body={
                    <>
                      Open <strong>Settings</strong> above and add one from the Agents tab to start
                      chatting.
                    </>
                  }
                />
              )}
              <AgentStatusBubbles
                statuses={agentStatuses}
                agentNameById={agentNameById}
                onStopAgent={onStopAgent}
              />
              {dispatchHint && (
                <DispatchHint message={dispatchHint} onDismiss={clearDispatchHint} />
              )}
              {pendingClarification && (
                <ClarificationPrompt
                  // Key by callId: a new request must remount with fresh (or
                  // draft-hydrated) state, not inherit the previous form's.
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
              <AgentPillsRow />
              <VoiceComposerDock />
              <SubagentStrip subagents={subagents} onOpen={openHelperThread ?? undefined} />
              <VisionSessionProvider threadId={threadId}>
                <VisionTransientCaptureCards />
                <VisionPreviewPanel />
                <Composer
                  placeholder={composerPlaceholder}
                  threadId={threadId}
                  onSubmit={ready && hasAgents ? sendMessage : undefined}
                  working={working}
                  onStop={onStop}
                  voiceControls={<VoiceToggle />}
                  voiceModeControls={
                    <>
                      <VoiceModeToggle />
                      <VisionComposerControl />
                    </>
                  }
                  restoreText={lastSendError?.text ?? null}
                  onRestored={clearSendError}
                  fillRequest={fillRequest}
                />
              </VisionSessionProvider>
            </div>

            {/* Wide mode: sidebar alongside chat */}
            {!isNarrow && settingsOpen && (
              <div className={styles.settingsSidebar} style={sidebarStyle}>
                <div
                  className={styles.sidebarResizeHandle}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize settings panel"
                  {...sidebarHandle}
                />
                {settingsPanel}
              </div>
            )}
          </div>
        </div>

        {showClear && (
          <ClearThreadModal
            threadId={threadId}
            threadTitle={threadTitle?.trim() || 'Untitled thread'}
            onClose={() => setShowClear(false)}
          />
        )}
      </div>
    </ThreadMessagingProvider>
  );
};
