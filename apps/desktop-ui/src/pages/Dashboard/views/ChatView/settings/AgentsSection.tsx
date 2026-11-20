import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { Button, Stack, TextInput } from '@desktop/components';
import type { ThreadParticipant } from '@desktop/utils/api';
import type { AgentEntry } from './settings-types';
import { agentEntries, agentEntryRole, loadThreadAgents } from './threadAgents';
import { AgentDetail } from './AgentDetail';
import { AgentThreadMemoriesPanel } from './AgentThreadMemoriesPanel';
import { useProposedMemories } from './useProposedMemories';
import { AddAgentModal } from '../AddAgentModal/AddAgentModal';
import { ExportButton } from '@desktop/components/ExportButton';
import { LeafToggle } from '@desktop/components/Icons';
import styles from './ChatSettings.module.scss';
import { getErrorMessage, getInitial } from '@snaglet/shared/utils';

/** Which full-view context list is showing, or null for the agent detail form. */
type ContextView = 'memories' | 'summaries' | null;

interface AgentsSectionProps {
  threadId: string;
  participantAgentIds?: string[];
  /**
   * Narrow-pane mode. When true the memories rail renders as an overlay
   * drawer over the detail form (instead of a side-by-side column) so
   * the detail editor keeps a usable width.
   */
  compact?: boolean;
  /** When set, preselect this agent in the sub-sidebar on load. */
  focusAgentId?: string | null;
  /**
   * The thread is a subagent helper's hidden thread: it belongs to that
   * helper alone, so it offers no way to add agents (the server refuses too).
   */
  helperThread?: boolean;
  /**
   * The thread's membership is fixed (a DM is between exactly its two
   * parties): no way to add an agent, and no "Remove from thread".
   */
  fixedParticipants?: boolean;
  /** Sub-focus passed to the per-agent context rail. */
  focusMemoryId?: string | null;
  focusSummaryId?: string | null;
  /**
   * A click on a memory-extraction notice: show the memories list for the focused
   * agent (proposals, if any, sit at its top). `n` distinguishes repeat clicks.
   */
  memoryNoticeRequest?: { n: number } | null;
  /**
   * Called after an agent is successfully added, so the parent chat
   * surface (composer enablement, participant count) can sync — this
   * section keeps its own copy of the participant list, so the parent
   * isn't notified for free.
   */
  onAgentAdded?: () => void;
  /**
   * Called after an agent is successfully removed, so the parent chat
   * surface (composer enablement, participant count) can sync — mirrors
   * `onAgentAdded` for the remove path.
   */
  onAgentRemoved?: () => void;
}

/**
 * Agents section: a sub-sidebar of the thread's participants, with the
 * selected agent's details on the right. Participants and the agent list load
 * in parallel and join locally; only a participant the list leaves out (a
 * subagent helper, an archived agent) is read by id. Adding an agent
 * (AddAgentModal) lives here too, except in a subagent's thread or a DM.
 */
export const AgentsSection: FC<AgentsSectionProps> = ({
  threadId,
  participantAgentIds,
  compact = false,
  focusAgentId = null,
  helperThread = false,
  fixedParticipants = false,
  focusMemoryId = null,
  focusSummaryId = null,
  memoryNoticeRequest = null,
  onAgentAdded,
  onAgentRemoved,
}) => {
  const [entries, setEntries] = useState<AgentEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const canAddAgents = !helperThread && !fixedParticipants;
  const handleAgentAdded = useCallback(() => {
    onAgentAdded?.();
  }, [onAgentAdded]);

  useEffect(() => {
    setSelectedId(null);
  }, [threadId]);

  useEffect(() => {
    if (focusAgentId) setSelectedId(focusAgentId);
  }, [threadId, focusAgentId]);

  useEffect(() => {
    let canceled = false;
    setEntries(null);
    setError(null);

    loadThreadAgents(threadId)
      .then((loaded) => {
        if (canceled) return;
        // This panel lists AI agents only. Human (kind: 'user') participants
        // are real members of the thread but belong to a different surface, so
        // they're filtered out by their principal kind rather than by guessing
        // at a blank agentId. An agent participant whose agent record is gone
        // (kind 'agent', agent null) is still shown so it stays removable.
        const next = agentEntries(loaded);
        setEntries(next);
        // Pre-select: if the pane was deep-linked with a focus, use that
        // agent when it's actually a participant; otherwise fall back to
        // the first participant so the right pane has something to show.
        // null stays reserved for the "no participants" empty state.
        setSelectedId((currentId) => {
          if (currentId && next.some((e) => e.participant.agentId === currentId)) return currentId;
          const focusedIsParticipant =
            focusAgentId && next.some((e) => e.participant.agentId === focusAgentId);
          return next.length > 0
            ? focusedIsParticipant
              ? focusAgentId
              : next[0].participant.agentId
            : null;
        });
      })
      .catch((err) => {
        if (canceled) return;
        setError(getErrorMessage(err, 'Failed to load agents'));
      });

    return () => {
      canceled = true;
    };
  }, [threadId, focusAgentId, participantAgentIds]);

  const selected = useMemo(
    () => entries?.find((e) => e.participant.agentId === selectedId) ?? null,
    [entries, selectedId]
  );

  const handleParticipantUpdated = useCallback((updated: ThreadParticipant) => {
    setEntries((prev) =>
      prev
        ? prev.map((e) =>
            e.participant.agentId === updated.agentId ? { ...e, participant: updated } : e
          )
        : prev
    );
  }, []);

  // Drop a removed participant from the list. When the removed agent was
  // the selected one, fall through to the first remaining participant (or
  // null, which surfaces the "no participants" empty state). Also notifies
  // the parent chat surface (mirrors handleAgentAdded's onAgentAdded?.())
  // so composer enablement / participant count re-sync without a remount.
  const handleParticipantRemoved = useCallback(
    (agentId: string) => {
      setEntries((prev) => (prev ? prev.filter((e) => e.participant.agentId !== agentId) : prev));
      if (selectedId === agentId) {
        const remaining = (entries ?? []).filter((e) => e.participant.agentId !== agentId);
        setSelectedId(remaining[0]?.participant.agentId ?? null);
      }
      onAgentRemoved?.();
    },
    [entries, selectedId, onAgentRemoved]
  );

  // Picker UI state — search input + popover open flag. The popover renders
  // inside (anchored to) `.agentsSelectedRow` and closes on selection or when
  // the user clicks outside `.agentsToolbar` — the toolbarRef below is used
  // only for that click-outside detection.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pickerListRef = useRef<HTMLDivElement | null>(null);

  // Which view owns the body, chosen by the tab strip below the selected-
  // agent row. `null` is the Settings tab (model / budget / tool access /
  // thread addendum); 'memories' / 'summaries' each open the full scrollable
  // list for that kind. The Settings tab is always present, so Memories /
  // Summaries are never dead ends — one click returns to the detail form.
  const [contextView, setContextView] = useState<ContextView>(
    focusSummaryId ? 'summaries' : focusMemoryId ? 'memories' : null
  );

  // Proposals recorded in this thread and still waiting on approval. They are the
  // human's, not any one agent's, so the list is the thread's: every agent's
  // Memories list shows it first, and the Memories tab carries its count.
  const { proposed, proposedError, loadProposed, resolveProposed } = useProposedMemories(threadId);
  // Each notice is handled once, by its request number: a thread switch or a
  // re-render must not re-open the list or refetch it.
  const noticeN = memoryNoticeRequest?.n ?? null;
  const handledNoticeN = useRef<number | null>(null);
  useEffect(() => {
    if (noticeN === null || handledNoticeN.current === noticeN) return;
    handledNoticeN.current = noticeN;
    // Saved and proposed memories share one list, proposals on top.
    setContextView('memories');
    // Something new was just proposed; the list may predate it.
    loadProposed();
  }, [noticeN, loadProposed]);

  // Deep-link to a memory or summary — jump straight to that list.
  useEffect(() => {
    if (focusSummaryId) setContextView('summaries');
    else if (focusMemoryId) setContextView('memories');
  }, [focusMemoryId, focusSummaryId]);

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      const name = (e.agent?.name ?? '').toLowerCase();
      const role = (agentEntryRole(e) ?? '').toLowerCase();
      const id = e.participant.agentId.toLowerCase();
      return name.includes(q) || role.includes(q) || id.includes(q);
    });
  }, [entries, search]);

  // Click outside the toolbar collapses the popover. Bound only while
  // open so we don't add a global mousedown listener for nothing.
  useEffect(() => {
    if (!pickerOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!toolbarRef.current) return;
      if (toolbarRef.current.contains(e.target as Node)) return;
      setPickerOpen(false);
      setSearch('');
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [pickerOpen]);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setSearch('');
    triggerRef.current?.focus();
  }, []);

  const onPickerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePicker();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const options = Array.from(
        pickerListRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
      );
      if (!options.length) return;
      const current = options.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : event.key === 'ArrowDown'
              ? (current + 1) % options.length
              : (current - 1 + options.length) % options.length;
      options[next]?.focus();
    },
    [closePicker]
  );

  if (entries === null && !error) {
    return (
      <Stack className={styles.pane}>
        <div className={styles.routingPlaceholder}>Loading agents…</div>
      </Stack>
    );
  }

  if (error) {
    return (
      <Stack className={styles.pane}>
        <div className={styles.error} role="alert">
          {error}
        </div>
      </Stack>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <Stack gap={2} className={styles.pane}>
        <p className={styles.sectionDescription}>
          No agents in this thread yet. Add one to bring someone in — they'll show up here once
          they're a participant.
        </p>
        {canAddAgents && (
          <Button
            variant="ghost"
            size="sm"
            className={styles.agentsSwapBtn}
            title="Add an agent to this thread"
            onClick={() => setShowAddAgent(true)}
          >
            + agent
          </Button>
        )}
        {showAddAgent && (
          <AddAgentModal
            threadId={threadId}
            existingAgentIds={[]}
            onClose={() => setShowAddAgent(false)}
            onAdded={handleAgentAdded}
          />
        )}
      </Stack>
    );
  }

  const selectedName = selected?.agent?.name ?? selected?.participant.agentId.slice(0, 8) ?? '';
  const selectedRole = selected ? agentEntryRole(selected) : null;
  // Only offer the switch when there is more than one agent in the thread.
  // A home thread / DM holds exactly one, so its card is static.
  const canSwitchAgents = entries.length > 1;

  return (
    <section className={`${styles.section} ${styles.agentsSection}`}>
      <div className={styles.agentsLayout}>
        <div className={styles.agentsToolbar} ref={toolbarRef}>
          {/* Selected-agent card. With another agent to switch to it is a
              dropdown trigger: the name + role opens a searchable picker.
              A home thread / DM holds a single agent, so there is nothing to
              switch to — then it renders as a plain static card: no chevron,
              no hover/pressed affordance, no tooltip, not focusable, and no
              combobox/button role. */}
          <span className={styles.agentsSelectorLabel}>Agent</span>
          <div className={styles.agentsSelectedRow}>
            {canSwitchAgents ? (
              <button
                ref={triggerRef}
                type="button"
                className={`${styles.agentsDropdownTrigger} ${pickerOpen ? styles.agentsDropdownTriggerOpen : ''}`}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                aria-label={'Agent, selected ' + (selectedName || 'none')}
                title="Switch to another agent in this thread"
                onClick={() => setPickerOpen((o) => !o)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' && !pickerOpen) {
                    event.preventDefault();
                    setPickerOpen(true);
                  }
                }}
              >
                <span className={styles.agentsListItemAvatar} aria-hidden>
                  {getInitial(selectedName)}
                </span>
                <span className={styles.agentsListItemBody}>
                  <span className={styles.agentsListItemName}>
                    {selectedName || 'Select agent'}
                  </span>
                  {selectedRole && (
                    <span className={styles.agentsListItemRole}>{selectedRole}</span>
                  )}
                </span>
                <LeafToggle open={pickerOpen} className={styles.agentsDropdownChevron} />
              </button>
            ) : (
              <div className={styles.agentsStaticCard}>
                <span className={styles.agentsListItemAvatar} aria-hidden>
                  {getInitial(selectedName)}
                </span>
                <span className={styles.agentsListItemBody}>
                  <span className={styles.agentsListItemName}>
                    {selectedName || 'Select agent'}
                  </span>
                  {selectedRole && (
                    <span className={styles.agentsListItemRole}>{selectedRole}</span>
                  )}
                </span>
              </div>
            )}
            {canAddAgents && (
              <Button
                variant="ghost"
                size="sm"
                className={styles.agentsAddBtn}
                title="Add an agent to this thread"
                onClick={() => setShowAddAgent(true)}
              >
                + Agent
              </Button>
            )}

            {pickerOpen && (
              <div className={styles.agentsPicker}>
                <div className={styles.agentsPickerSearch}>
                  <TextInput
                    type="search"
                    size="sm"
                    fullWidth
                    autoFocus
                    placeholder="Search agents…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown') onPickerKeyDown(event);
                      else if (event.key === 'Escape') closePicker();
                    }}
                    aria-label="Search thread agents"
                  />
                </div>
                <div
                  ref={pickerListRef}
                  className={styles.agentsPickerList}
                  role="listbox"
                  aria-label="Thread agents"
                  onKeyDown={onPickerKeyDown}
                >
                  {filteredEntries.length === 0 ? (
                    <div className={styles.agentsPickerEmpty}>No matches</div>
                  ) : (
                    filteredEntries.map((entry) => {
                      const id = entry.participant.agentId;
                      const active = selectedId === id;
                      const displayName = entry.agent?.name ?? id.slice(0, 8);
                      const role = agentEntryRole(entry);
                      return (
                        <button
                          key={id}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`${styles.agentsListItem} ${active ? styles.agentsListItemActive : ''}`}
                          onClick={() => {
                            setSelectedId(id);
                            setPickerOpen(false);
                            setSearch('');
                          }}
                        >
                          <span className={styles.agentsListItemAvatar} aria-hidden>
                            {getInitial(displayName)}
                          </span>
                          <span className={styles.agentsListItemBody}>
                            <span className={styles.agentsListItemName}>{displayName}</span>
                            {role && <span className={styles.agentsListItemRole}>{role}</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {showAddAgent && (
            <AddAgentModal
              threadId={threadId}
              existingAgentIds={entries.map((entry) => entry.participant.agentId)}
              onClose={() => setShowAddAgent(false)}
              onAdded={handleAgentAdded}
            />
          )}

          {/* Tab strip — Settings / Memories / Summaries. Settings (null
              contextView) is always selectable, so the list views are never
              a dead end. Tabs select rather than toggle. Proposed memories
              sit at the top of the Memories list; their count rides on its tab. */}
          <div
            className={styles.agentsContextNav}
            role="group"
            aria-label="Agent settings sections"
          >
            <Button
              variant="ghost"
              size="sm"
              className={styles.agentsContextNavBtn}
              aria-pressed={contextView === null}
              title="Model, budget, tool access and thread prompt"
              onClick={() => setContextView(null)}
            >
              Settings
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.agentsContextNavBtn}
              aria-pressed={contextView === 'memories'}
              aria-label={proposed.length > 0 ? `Memories, ${proposed.length} proposed` : undefined}
              title={
                proposed.length > 0
                  ? `Show this agent's memories in this thread, and ${proposed.length} proposed for your approval`
                  : "Show this agent's memories in this thread"
              }
              onClick={() => {
                setContextView('memories');
                loadProposed();
              }}
            >
              Memories
              {proposed.length > 0 && (
                <span className={styles.agentsContextNavCount} aria-hidden>
                  {proposed.length}
                </span>
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.agentsContextNavBtn}
              aria-pressed={contextView === 'summaries'}
              title="Show this agent's thread summaries"
              onClick={() => setContextView('summaries')}
            >
              Summaries
            </Button>
          </div>
        </div>
        {/* Export all of this agent's memories as one file, not the
            thread-scoped slice listed below. Memories have no pane of their
            own, so this is the only surface that reaches them. */}
        {selected && contextView === 'memories' && (
          <div className={styles.agentsExportRow}>
            <ExportButton
              kind="agent_memories"
              id={selected.participant.agentId}
              suggestedName={`${selected.agent?.name ?? 'agent'} memories.md`}
              label="Export all memories"
            />
          </div>
        )}
        <div className={styles.agentsBody}>
          {selected && contextView ? (
            // Context list takes over the whole body — a scrollable list of
            // either this agent's memories or its thread summaries, chosen
            // by the toolbar nav above.
            <AgentThreadMemoriesPanel
              tab={contextView}
              agentId={selected.participant.agentId}
              agentName={selected.agent?.name ?? null}
              threadId={threadId}
              focusMemoryId={focusMemoryId}
              focusSummaryId={focusSummaryId}
              proposed={proposed}
              proposedError={proposedError}
              onResolveProposed={resolveProposed}
            />
          ) : (
            <div className={`${styles.agentsDetail} ${compact ? styles.agentsDetailCompact : ''}`}>
              {selected ? (
                // One instance per thread and agent: a save that settles after
                // a switch lands in the detail it started from, which is gone,
                // instead of writing its text into the next agent's.
                <AgentDetail
                  key={`${threadId}:${selected.participant.agentId}`}
                  entry={selected}
                  threadId={threadId}
                  onParticipantUpdated={handleParticipantUpdated}
                  onParticipantRemoved={handleParticipantRemoved}
                  canRemove={!fixedParticipants}
                />
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
