import { useEffect, useRef, useState, type FC, type KeyboardEvent, type MouseEvent } from 'react';
import type { SubagentSummary } from '@snaglet/shared/types';
import { isoNow } from '@snaglet/shared/utils';
import { Chip, type ChipTone } from '@desktop/components';
import { ContextMenu, type ContextMenuProps } from '@desktop/components/ContextMenu';
import { formatElapsed } from '@desktop/components/StatusBar/consumers/ActiveAgentsPopover';
import { useNow } from '@desktop/hooks/useNow';
import { useToolApprovalPending } from '@desktop/utils/notificationState';
import { useThreadRunning } from '@desktop/utils/threadRunState';
import { PauseUntilPopover } from './PauseUntilPopover';
import { pauseHelper, removeHelper, resumeHelper } from './subagentActions';
import {
  helperProblem,
  helperThreadTitle,
  liveSubagentLabel,
  liveSubagentStatus,
  type LiveSubagentState,
} from './subagentText';
import styles from './SubagentStrip.module.scss';

const TONE: Record<LiveSubagentState, ChipTone> = {
  running: 'primary',
  waiting: 'warning',
  finished: 'success',
  failed: 'error',
  stopped: 'muted',
};

interface SubagentStripProps {
  /** The thread's live helpers (useThreadSubagents). */
  subagents: SubagentSummary[];
  /**
   * Open a helper's thread in this pane. Without it (previews) chips are
   * static: not clickable and without the actions menu.
   */
  onOpen?: (threadId: string, title: string) => void;
}

type ChipMenu = { kind: 'menu'; x: number; y: number } | { kind: 'until' } | null;

/** A finished or failed helper is not working: there is nothing to pause, only to remove. */
function isDone(state: LiveSubagentState): boolean {
  return state === 'finished' || state === 'failed';
}

/**
 * A helper's menu. While it works: Pause, Pause for 15 min / 1 hour /
 * until…, Remove. Paused: Resume, the timed pauses (pausing again re-times
 * it), Remove. Finished or failed: Remove only (its orchestrator retries a
 * failed one with op:send; writing in its thread works too).
 */
function subagentMenuItems(
  subagent: SubagentSummary,
  state: LiveSubagentState,
  onPauseUntil: () => void
): ContextMenuProps['items'] {
  const remove = { label: 'Remove', onSelect: () => void removeHelper(subagent) };
  if (isDone(state)) return [remove];
  return [
    state === 'stopped'
      ? { label: 'Resume', onSelect: () => void resumeHelper(subagent) }
      : { label: 'Pause', onSelect: () => void pauseHelper(subagent) },
    { label: 'Pause for 15 min', onSelect: () => void pauseHelper(subagent, { for: '15m' }) },
    { label: 'Pause for 1 hour', onSelect: () => void pauseHelper(subagent, { for: '1h' }) },
    { label: 'Pause until…', onSelect: onPauseUntil },
    remove,
  ];
}

const SubagentChip: FC<{ subagent: SubagentSummary; onOpen?: SubagentStripProps['onOpen'] }> = ({
  subagent,
  onOpen,
}) => {
  const threadRunning = useThreadRunning(subagent.threadId ?? '');
  // The helper's thread is hidden, so its approval prompt reaches the user as
  // a `tool_approval` notification; that is the signal it is waiting.
  const approvalPending = useToolApprovalPending(subagent.threadId ?? '');
  const status = liveSubagentStatus(subagent.status, threadRunning, approvalPending);
  // A run the row does not know about yet (the user wrote to the helper
  // directly) times from when this view first saw it.
  const [seenRunningAt, setSeenRunningAt] = useState<string | null>(null);
  const untracked = threadRunning && subagent.status !== 'running';
  useEffect(() => {
    setSeenRunningAt((prev) => (untracked ? (prev ?? isoNow()) : null));
  }, [untracked]);
  const now = useNow(status === 'running');
  const startedAt = subagent.status === 'running' ? subagent.lastTaskAt : seenRunningAt;
  const state =
    status === 'running'
      ? `running ${formatElapsed(startedAt ?? isoNow(), now)}`
      : liveSubagentLabel(status, subagent.resumeAt);
  const threadId = subagent.threadId;
  const title = helperThreadTitle(subagent.orchestratorName, subagent.name);
  const interactive = Boolean(onOpen && threadId);
  // Why it failed or stopped, while the row still says so (not while a new run is going).
  const problem = status === subagent.status ? helperProblem(subagent) : null;

  const [menu, setMenu] = useState<ChipMenu>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const openMenuBelow = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setMenu({ kind: 'menu', x: rect.left, y: rect.bottom + 4 });
  };
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!interactive) return;
    event.preventDefault();
    setMenu({ kind: 'menu', x: event.clientX, y: event.clientY });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!interactive) return;
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault();
      openMenuBelow(event.currentTarget);
    }
  };

  const chip = (
    <Chip
      tone={TONE[status]}
      size="sm"
      variant="outline"
      className={styles.chip}
      icon={<span className={styles.dot} data-status={status} />}
      onClick={onOpen && threadId ? () => onOpen(threadId, title) : undefined}
      title={
        interactive
          ? [problem, `Open ${subagent.name}'s thread — you can write to it like any thread`]
              .filter(Boolean)
              .join('\n')
          : (problem ?? undefined)
      }
    >
      <span className={styles.name}>{subagent.name}</span>
      <span className={styles.sep} aria-hidden>
        ·
      </span>
      <span className={styles.model}>{subagent.modelId}</span>
      <span className={styles.sep} aria-hidden>
        ·
      </span>
      <span className={styles.state} data-tid="subagentState">
        {state}
      </span>
    </Chip>
  );
  if (!interactive) return chip;

  return (
    <span className={styles.chipGroup} onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
      {chip}
      <button
        ref={menuButtonRef}
        type="button"
        className={styles.menuButton}
        aria-label={`Actions for ${subagent.name}`}
        aria-haspopup="menu"
        aria-expanded={menu?.kind === 'menu'}
        title={
          isDone(status) ? `Remove ${subagent.name}` : `Pause, resume or remove ${subagent.name}`
        }
        onClick={(event) => openMenuBelow(event.currentTarget)}
      >
        ⋯
      </button>
      {menu?.kind === 'menu' && (
        <ContextMenu
          ariaLabel={`${subagent.name} actions`}
          x={menu.x}
          y={menu.y}
          items={subagentMenuItems(subagent, status, () => setMenu({ kind: 'until' }))}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === 'until' && menuButtonRef.current && (
        <PauseUntilPopover
          anchor={menuButtonRef.current}
          name={subagent.name}
          onCancel={() => setMenu(null)}
          onPause={(until) => {
            setMenu(null);
            void pauseHelper(subagent, { until });
          }}
        />
      )}
    </span>
  );
};

/**
 * One chip per live subagent helper of the thread, just above the composer:
 * name · model · state. A chip opens the helper's thread in this pane, where
 * the user can follow the run and write to the helper like any agent; Back
 * returns here. Its ⋯ button, a right-click, or Shift+F10 opens the actions:
 * pause, pause for a while, resume, remove (only remove once it finished or
 * failed). Renders nothing while the thread has no helpers.
 */
export const SubagentStrip: FC<SubagentStripProps> = ({ subagents, onOpen }) => {
  if (subagents.length === 0) return null;
  return (
    <div className={styles.strip} role="group" aria-label="Subagents" data-tid="subagentStrip">
      <span className={styles.label}>subagents</span>
      {subagents.map((subagent) => (
        <SubagentChip key={subagent.id} subagent={subagent} onOpen={onOpen} />
      ))}
    </div>
  );
};
