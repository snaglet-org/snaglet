import { useCallback, useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { ContextSection } from './ContextSection';
import { RoutingSection } from './RoutingSection';
import { WorkingFolderSection } from './WorkingFolderSection';
import { AgentsSection } from './AgentsSection';
import { MaintenanceSection } from './MaintenanceSection';
import { Tabs } from '@desktop/components';
import { useElementWidth } from '@desktop/hooks/useElementWidth';
import { OpenInSidebarButton } from '../../../chrome/PaneChrome/openInSidebar';
import styles from './ChatSettings.module.scss';

/**
 * Below this pane width the settings surface switches from a left tab
 * rail to a horizontal tab strip on top, and the Agents section's
 * memories rail becomes an overlay drawer instead of a side-by-side
 * column. Keeps the detail form usable in narrow split-screen panes.
 */
const COMPACT_WIDTH = 560;

// Each section is its own module: ContextSection is the "General" tab
// (project, text size, system prompt, notifications, conversation limits),
// RoutingSection holds dispatch_mode, AgentsSection the participants.

interface ChatSettingsProps {
  threadId: string;
  /** Current thread size for Maintenance, e.g. "1,820 messages · 12.6 MB". */
  trimSummary?: string | null;
  trimDetail?: string | null;
  trimError?: string | null;
  trimResult?: string | null;
  onOpenTrim?: () => void;
  /**
   * Whether the Trim view is open. ChatView owns trim state (the message list
   * dims against the same plan), so this surface only hosts `trimPanel` inside
   * the Maintenance tab and reports when the user leaves it via `onCloseTrim`.
   */
  trimOpen?: boolean;
  trimPanel?: ReactNode;
  onCloseTrim?: () => void;
  onClear?: () => void;
  participantAgentIds?: string[];
  /**
   * When set, force the Agents section active and preselect this agent
   * in the sub-sidebar. Used by the WorkspaceTree's per-thread Agents
   * leaf so clicking an agent row deep-links straight to its detail.
   * `null` means "open whatever section the user was last on" (default
   * `'context'`).
   */
  focusAgentId?: string | null;
  /**
   * Sub-focus inside the per-agent context rail. When set, the rail
   * switches to the matching tab and scrolls the matching row into
   * view. Only one of the two should be set at a time. Implies
   * `focusAgentId` is also set so the right agent's panel is showing.
   */
  focusMemoryId?: string | null;
  focusSummaryId?: string | null;
  /** A click on a memory-extraction notice (see AgentsSection). */
  memoryNoticeRequest?: { n: number } | null;
  /** The thread is a subagent helper's hidden thread (see AgentsSection). */
  helperThread?: boolean;
  /**
   * Show only these tabs, in their usual order (a home thread shows
   * `['agents', 'maintenance']`). Unset: every tab, or a subagent's two.
   * `notifications` counts as General, the tab that holds it.
   */
  sections?: readonly (ChatSettingsSection | 'notifications')[];
  /**
   * The thread's membership is fixed (a DM is between exactly its two
   * parties): the Agents tab offers no way to add or remove an agent.
   */
  fixedParticipants?: boolean;
  /**
   * Called after an agent is successfully added to the thread from the
   * Agents section, so the chat surface (composer enablement, participant
   * count) stays in sync. Threads through to `AgentsSection`'s add-agent
   * control.
   */
  onAgentAdded?: () => void;
  /**
   * Called after an agent is removed from the thread in the Agents section,
   * so the chat surface (composer enablement, participant count) stays in
   * sync. The remove-path counterpart of `onAgentAdded`.
   */
  onAgentRemoved?: () => void;
  /**
   * Show the pane's "Open in sidebar" above the sections. Only ChatView sets
   * it (it claims the button off the topbar); DmView's home-thread settings
   * sit in an agent pane, where the pane's item is the agent, not the thread.
   */
  showOpenInSidebar?: boolean;
}

// `context` is the General tab: the id predates the label and is kept so
// existing callers and deep links still land there.
export type ChatSettingsSection = 'context' | 'routing' | 'folder' | 'agents' | 'maintenance';
type SettingsSection = ChatSettingsSection;
const ALL_SECTION_IDS = ['context', 'routing', 'folder', 'agents', 'maintenance'] as const;

/**
 * Section ids without a tab of their own (a stored tab, a deep link), mapped
 * to the tab that holds their settings: `notifications` lives in General.
 */
const LEGACY_SECTIONS: Readonly<Record<string, SettingsSection>> = {
  notifications: 'context',
};

/** A section id from anywhere (a stored tab, a deep link) as a current one. */
function normalizeSettingsSection(id: string): SettingsSection | null {
  if ((ALL_SECTION_IDS as readonly string[]).includes(id)) return id as SettingsSection;
  return LEGACY_SECTIONS[id] ?? null;
}

// General (and its run-ended Notifications row) is left out on purpose: a
// helper's thread is hidden and NotificationService drops its run:end, so the
// setting could never fire.
const HELPER_SECTIONS: ReadonlySet<SettingsSection> = new Set(['agents', 'maintenance']);
const ALL_SECTIONS: ReadonlySet<SettingsSection> = new Set(ALL_SECTION_IDS);

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'context', label: 'General' },
  { id: 'routing', label: 'Routing' },
  { id: 'folder', label: 'Folder' },
  { id: 'agents', label: 'Agents' },
  { id: 'maintenance', label: 'Maintenance' },
];

/**
 * Thread-settings surface: section tabs on the left, the active section on
 * the right. Tabs are General, Routing, Folder (the working directory agents
 * start in), Agents and Maintenance (thread size, the Trim view, Clear). A
 * subagent's thread shows only Agents and Maintenance; `sections` narrows the
 * set for other callers.
 */
export const ChatSettings: FC<ChatSettingsProps> = ({
  threadId,
  trimSummary = null,
  trimDetail = null,
  trimError = null,
  trimResult = null,
  onOpenTrim,
  trimOpen = false,
  trimPanel = null,
  onCloseTrim,
  onClear,
  participantAgentIds,
  focusAgentId = null,
  focusMemoryId = null,
  focusSummaryId = null,
  memoryNoticeRequest = null,
  helperThread = false,
  sections: sectionsProp,
  fixedParticipants = false,
  onAgentAdded,
  onAgentRemoved,
  showOpenInSidebar = false,
}) => {
  // Initialize to 'agents' when the pane was opened with any per-agent
  // focus so the user lands directly on the surface that hosts the
  // item they clicked. Subsequent changes (rare — same pane, new
  // deep-link) jump back via the effect below.
  const wantsAgents = Boolean(focusAgentId || focusMemoryId || focusSummaryId);
  // A subagent's thread shows only Agents and Maintenance: it has one agent
  // and nothing to route, and Snaglet sets its limits itself (no wave cap, the
  // largest output budget; see resolveThreadRuntimeConfig).
  // A stored `notifications` id maps onto the tab that holds it.
  const allowed: ReadonlySet<SettingsSection> = sectionsProp
    ? new Set(
        sectionsProp
          .map((id) => normalizeSettingsSection(id))
          .filter((id): id is SettingsSection => id !== null)
      )
    : helperThread
      ? HELPER_SECTIONS
      : ALL_SECTIONS;
  const sections = SECTIONS.filter((section) => allowed.has(section.id));
  // A remount while Trim is open (the pane crossing the sidebar/drawer width)
  // must land back on Maintenance, where the Trim view lives.
  const [active, setActive] = useState<SettingsSection>(() => {
    if ((wantsAgents || helperThread) && allowed.has('agents')) return 'agents';
    if (trimOpen && allowed.has('maintenance')) return 'maintenance';
    return allowed.has('context') ? 'context' : (sections[0]?.id ?? 'agents');
  });
  useEffect(() => {
    if (wantsAgents) setActive('agents');
  }, [wantsAgents]);
  // Each notice jumps to Agents once, by its request number; `allowed` is
  // rebuilt every render, so the ref keeps later renders from re-jumping.
  const noticeRequestN = memoryNoticeRequest?.n ?? null;
  const handledNoticeN = useRef<number | null>(null);
  useEffect(() => {
    if (noticeRequestN === null || handledNoticeN.current === noticeRequestN) return;
    handledNoticeN.current = noticeRequestN;
    if (allowed.has('agents')) setActive('agents');
  }, [noticeRequestN, allowed]);

  // Trim is a sub-view of Maintenance. Every entry point (Maintenance's
  // "Trim now", General's near-threshold notice) selects that tab first, so
  // Cancel returns to Maintenance rather than wherever Trim was opened from.
  const openTrim = useCallback(() => {
    setActive('maintenance');
    onOpenTrim?.();
  }, [onOpenTrim]);

  // Trim must never stay open behind another tab: the thread would keep
  // dimming a cut the user can't see. Leaving only closes the view; deleting
  // still requires the panel's own confirmation.
  const showTrim = trimOpen && active === 'maintenance' && trimPanel != null;
  useEffect(() => {
    if (trimOpen && active !== 'maintenance') onCloseTrim?.();
  }, [trimOpen, active, onCloseTrim]);

  const selectSection = (next: SettingsSection) => {
    // Any tab click while Trim is open leaves it — clicking Maintenance
    // itself returns to the Maintenance overview.
    if (trimOpen) onCloseTrim?.();
    setActive(next);
  };

  // Measure the pane so the layout can collapse responsively. The
  // settings surface lives inside an independently-resizable split
  // pane, so viewport media queries don't apply — we watch our own box.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(rootRef);
  const compact = width !== null && width < COMPACT_WIDTH;

  // One section (a home thread narrowed to Agents) needs no chooser: render
  // the section alone, no tab strip and no `tab` roles.
  const showTabs = sections.length > 1;

  return (
    <div className={`${styles.root} ${compact ? styles.rootCompact : ''}`} ref={rootRef}>
      {showTabs && (
        <Tabs
          className={`${styles.sidebar} ${compact ? styles.sidebarHorizontal : ''}`}
          orientation={compact ? 'horizontal' : 'vertical'}
          value={active}
          onChange={(next) => {
            const section = normalizeSettingsSection(next);
            if (section) selectSection(section);
          }}
          size="sm"
          aria-label="Settings sections"
        >
          {sections.map((s) => (
            <Tabs.Tab key={s.id} value={s.id}>
              {s.label}
            </Tabs.Tab>
          ))}
        </Tabs>
      )}
      <div className={styles.main}>
        {/* The thread's "Open in sidebar" sits in its own row above the
            scrolling body (ChatView claims it off the topbar), so a
            full-height section like Agents keeps its height. The Trim tool
            keeps the panel to itself. */}
        {showOpenInSidebar && !showTrim && (
          <div className={styles.openInSidebarRow}>
            <OpenInSidebarButton />
          </div>
        )}
        <div
          className={[
            styles.body,
            showTrim ? styles.bodyFlush : active !== 'agents' && compact ? styles.bodyCompact : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {active === 'context' && allowed.has('context') && (
            <ContextSection threadId={threadId} onOpenTrim={onOpenTrim ? openTrim : undefined} />
          )}
          {active === 'routing' && allowed.has('routing') && <RoutingSection threadId={threadId} />}
          {active === 'folder' && allowed.has('folder') && (
            <WorkingFolderSection threadId={threadId} />
          )}
          {active === 'agents' && allowed.has('agents') && (
            <AgentsSection
              threadId={threadId}
              participantAgentIds={participantAgentIds}
              compact={compact}
              focusAgentId={focusAgentId}
              helperThread={helperThread}
              fixedParticipants={fixedParticipants}
              focusMemoryId={focusMemoryId}
              focusSummaryId={focusSummaryId}
              memoryNoticeRequest={memoryNoticeRequest}
              onAgentAdded={onAgentAdded}
              onAgentRemoved={onAgentRemoved}
            />
          )}
          {showTrim
            ? trimPanel
            : active === 'maintenance' &&
              allowed.has('maintenance') &&
              onOpenTrim &&
              onClear && (
                <MaintenanceSection
                  trimSummary={trimSummary}
                  trimDetail={trimDetail}
                  trimError={trimError}
                  trimResult={trimResult}
                  onOpenTrim={openTrim}
                  onClear={onClear}
                />
              )}
        </div>
      </div>
    </div>
  );
};
