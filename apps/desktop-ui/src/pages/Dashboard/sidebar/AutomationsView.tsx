import { mountedDisclosure } from '@desktop/ws/sidebarMounted';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { AutomationRecord } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, Switch } from '@desktop/components';
import { ContextMenu } from '@desktop/components/ContextMenu';
import { MoveHookToTrashModal } from '@desktop/components/Modal';
import { EditIcon, PauseIcon, PlayIcon, TrashIcon } from '@desktop/components/Icons';
import { Tree, TreeGroup, TreeRow } from '@desktop/components/SidebarTree';
import {
  formatAutomationNextRun,
  pauseAutomation,
  resumeAutomation,
  toastUndoAndReload,
} from '@desktop/features/automations/automationActions';
import {
  automationSentence,
  scriptSentence,
} from '@desktop/features/automations/automationSentences';
import { upsertAutomation, useAutomations } from '@desktop/features/automations/automationsStore';
import { RunningBadge } from '@desktop/features/automations/RunningSwirl';
import { useScripts, type ScriptBuild } from '@desktop/features/automations/useScripts';
import type { HookWorkspaceInfo } from '@desktop/utils/api';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { showToast } from '@desktop/utils/toast';
import type { DetailSelection } from '../selection/types';
import { AutomationsRunLog } from './AutomationsRunLog';
import { SidebarView } from './SidebarView';
import styles from './AutomationsView.module.scss';

// The archive drop zone's MIME (the sidebar trash), repeated locally like
// every other row that drags onto it (AgentsList, ToolsView, …).
const TREE_NODE_MIME = 'application/x-snaglet-tree-node';

type GroupId = 'active' | 'off' | 'finished' | 'runs';
type ListGroupId = Exclude<GroupId, 'runs'>;

const GROUPS: Array<{ id: ListGroupId; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'off', label: 'Paused or off' },
  { id: 'finished', label: 'Finished' },
];

const ROW_SELECTOR = '[role="treeitem"], [role="button"][aria-expanded]';

type ListedRow =
  | { kind: 'automation'; name: string; automation: AutomationRecord }
  | { kind: 'script'; name: string; script: HookWorkspaceInfo };

function automationGroup(a: AutomationRecord): ListGroupId | null {
  if (a.status === 'active') return 'active';
  if (a.status === 'paused') return 'off';
  if (a.status === 'finished') return 'finished';
  return null;
}

/** An unregistered script (no flag yet) cannot run, so it lists with the off ones. */
const scriptGroup = (enabled: boolean | undefined): ListGroupId => (enabled ? 'active' : 'off');

/**
 * The sentence, then the next run ("next Tue, Nov 3, 9:00 AM", or "next when
 * Snaglet first opens, from Tue, Nov 3, 5:00 AM" for a first-open one, as the pane
 * says it) or why it is paused.
 */
function automationRowMeta(a: AutomationRecord): string {
  const parts = [automationSentence(a)];
  if (a.status === 'active' && a.nextRunAt) {
    parts.push(`next ${formatAutomationNextRun(a).replace(/^When /, 'when ')}`);
  }
  if (a.status === 'paused') {
    parts.push(
      a.pausedReason === 'failures' ? `Paused after ${a.consecutiveFailures} failures` : 'Paused'
    );
  }
  return parts.join(' · ');
}

/** Puts a pane selection on a drag, for a drop into a pane split. */
function dragSelection(event: ReactDragEvent<HTMLElement>, selection: DetailSelection): void {
  event.dataTransfer.setData(PANE_ITEM_MIME, JSON.stringify(selection));
  event.dataTransfer.effectAllowed = 'all';
}

/**
 * A script's build when it keeps the script from running, in words. A listed
 * script has its folder, so the registry's `missing` never shows here.
 */
function buildNote(build: ScriptBuild | undefined): string | null {
  if (!build) return 'Not built yet';
  if (build.status === 'failed') return 'Build failed';
  if (build.status === 'pending' || build.status === 'building') return 'Building…';
  return null;
}

/**
 * Pause (Active) or Resume (Paused) from the row, with Undo in a toast.
 * Finished and deleted automations have nothing to toggle.
 */
const RowToggle: FC<{ automation: AutomationRecord }> = ({ automation: a }) => {
  const [pending, setPending] = useState(false);
  if (a.status !== 'active' && a.status !== 'paused') return null;
  const pausing = a.status === 'active';

  const toggle = async () => {
    setPending(true);
    try {
      const action = pausing ? pauseAutomation : resumeAutomation;
      upsertAutomation(await action(a, toastUndoAndReload));
    } catch (err) {
      showToast(getErrorMessage(err, pausing ? "Couldn't pause" : "Couldn't resume"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="xs"
      iconOnly
      className={styles.rowBtn}
      disabled={pending}
      onClick={(event) => {
        // The row opens the automation; this only pauses or resumes it.
        event.stopPropagation();
        void toggle();
      }}
      // Enter/Space press the button; the row must not also open the pane.
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
      title={pausing ? 'Pause' : 'Resume'}
      aria-label={`${pausing ? 'Pause' : 'Resume'} ${a.name}`}
    >
      {pausing ? <PauseIcon /> : <PlayIcon />}
    </Button>
  );
};

interface AutomationsViewProps {
  onOpen: (automation: AutomationRecord) => void;
  onCreate: () => void;
  /** Opens a script's page (code, runs, on or off) in the pane. */
  onScriptOpen: (script: HookWorkspaceInfo) => void;
  /** Opens the New script page. */
  onScriptCreate: () => void;
  /** Automation open in the active pane. */
  activeAutomationId: string | null;
  /** Script open in the active pane (its name). */
  activeScriptName?: string | null;
  /**
   * Cross-view reveal ("Open in sidebar"): scroll to this row and pulse it.
   * An automation's id, or a script's name.
   */
  revealNodeId?: string | null;
  revealNonce?: number;
}

/**
 * Everything that runs on its own, in one list: timed automations (an agent
 * woken in a thread on a schedule) and scripts (code in `~/.snaglet/hooks/<name>/`
 * run on events or schedules). Rows read "starts when → does" and group into
 * Active, Paused or off, and Finished (deleted automations are kept only for
 * history and undo, so they are not listed), with one run log below. The
 * shared store keeps automations live on `automations:changed`. A row opens
 * its page in the pane, drags into a split, or drags onto the sidebar trash.
 */
export const AutomationsView: FC<AutomationsViewProps> = ({
  onOpen,
  onCreate,
  onScriptOpen,
  onScriptCreate,
  activeAutomationId,
  activeScriptName = null,
  revealNodeId = null,
  revealNonce = 0,
}) => {
  const { automations, error } = useAutomations();
  const scriptsState = useScripts();
  const { scripts, enabledByName, buildByName, declaredByName, toggling } = scriptsState;
  const [closed, setClosed] = useState<ReadonlySet<GroupId>>(() => new Set());
  const [pulseId, setPulseId] = useState<string | null>(null);
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HookWorkspaceInfo | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const listedAutomations = useMemo(
    () => (automations ?? []).filter((a) => a.status !== 'cancelled'),
    [automations]
  );

  const groups = useMemo(() => {
    const by = new Map<ListGroupId, ListedRow[]>(GROUPS.map((g) => [g.id, []]));
    for (const a of listedAutomations) {
      const group = automationGroup(a);
      if (group) by.get(group)?.push({ kind: 'automation', name: a.name, automation: a });
    }
    for (const script of scripts ?? []) {
      by.get(scriptGroup(enabledByName.get(script.hookName)))?.push({
        kind: 'script',
        name: script.hookName,
        script,
      });
    }
    for (const rows of by.values()) rows.sort((x, y) => x.name.localeCompare(y.name));
    return GROUPS.map((g) => ({ ...g, rows: by.get(g.id) ?? [] })).filter((g) => g.rows.length > 0);
  }, [listedAutomations, scripts, enabledByName]);
  const listed = groups.reduce((n, g) => n + g.rows.length, 0);
  // Both lists answered (rows or an error); each shows its rows as soon as it has them.
  const ready =
    (automations !== null || Boolean(error)) && (scripts !== null || Boolean(scriptsState.error));

  const setGroupOpen = (id: GroupId, open: boolean) =>
    setClosed((prev) => {
      if (prev.has(id) !== open) return prev;
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });

  // Reveal: open the row's group, then scroll to the row and pulse it. A
  // request (id + nonce) is handled once: the effect also re-runs on every
  // `automations:changed` refetch (a new list), which must not pulse again.
  // Until the row is in the list the request stays pending. The timers live in
  // a ref, not the effect's cleanup, so such a re-run neither drops a pending
  // scroll nor restarts one; they are cleared when the view unmounts.
  const handledReveal = useRef<string | null>(null);
  const revealTimers = useRef<{ scroll: number | null; pulse: number | null }>({
    scroll: null,
    pulse: null,
  });
  useEffect(() => {
    if (!revealNodeId) return;
    const request = `${revealNodeId}:${revealNonce}`;
    if (handledReveal.current === request) return;
    const automation = listedAutomations.find((a) => a.id === revealNodeId);
    const script = automation ? undefined : scripts?.find((s) => s.hookName === revealNodeId);
    const group = automation
      ? automationGroup(automation)
      : script
        ? scriptGroup(enabledByName.get(script.hookName))
        : null;
    if (!group) return;
    handledReveal.current = request;
    setGroupOpen(group, true);
    const timers = revealTimers.current;
    if (timers.scroll !== null) window.clearTimeout(timers.scroll);
    if (timers.pulse !== null) window.clearTimeout(timers.pulse);
    timers.scroll = window.setTimeout(() => {
      const row = treeRef.current?.querySelector<HTMLElement>(
        `[data-reveal-id="${CSS.escape(revealNodeId)}"]`
      );
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setPulseId(revealNodeId);
      timers.pulse = window.setTimeout(() => setPulseId(null), 1600);
    }, 60);
  }, [revealNodeId, revealNonce, listedAutomations, scripts, enabledByName]);
  useEffect(() => {
    const timers = revealTimers.current;
    return () => {
      if (timers.scroll !== null) window.clearTimeout(timers.scroll);
      if (timers.pulse !== null) window.clearTimeout(timers.pulse);
      timers.scroll = timers.pulse = null;
      handledReveal.current = null; // a remount (StrictMode) handles the request afresh
    };
  }, []);

  // Roving keyboard navigation over the visible group headers and rows.
  const onTreeKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    const rows = Array.from(treeRef.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? []);
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    let next = index;
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1);
    if (e.key === 'ArrowUp') next = Math.max(0, index - 1);
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = rows.length - 1;
    if (next !== index || index === -1) {
      e.preventDefault();
      rows[Math.max(0, next)]?.focus();
    }
  }, []);

  const openScriptByName = useCallback(
    (name: string) => {
      const script = scripts?.find((s) => s.hookName === name);
      if (script) onScriptOpen(script);
      return Boolean(script);
    },
    [scripts, onScriptOpen]
  );

  const openCreateMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setCreateMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  // Clicks on a row's controls (even disabled ones) only work the control.
  const fromControl = (event: ReactMouseEvent) =>
    event.target instanceof Element && Boolean(event.target.closest('button'));
  // Enter/Space open the row only when the row itself has focus.
  const openKey = (event: ReactKeyboardEvent<HTMLElement>, open: () => void) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  const renderAutomation = (a: AutomationRecord) => (
    <TreeRow
      key={a.id}
      as="div"
      role="treeitem"
      tabIndex={0}
      depth={1}
      chevron="empty"
      active={activeAutomationId === a.id}
      aria-selected={activeAutomationId === a.id}
      reveal={pulseId === a.id}
      dimmed={a.status !== 'active' && !a.running}
      data-inspect-name={a.name}
      data-inspect-id={a.id}
      data-reveal-id={a.id}
      data-testid={`automation-row-${a.id}`}
      paneSelection={{ kind: 'automation-detail', automation_id: a.id, name: a.name }}
      onDragStart={(event) => {
        // TREE_NODE_MIME: drop onto the trash to archive it. (The
        // pane payload comes from paneSelection.) The workspace
        // tree moves only its own kinds, so a drop there does nothing.
        event.dataTransfer.setData(
          TREE_NODE_MIME,
          JSON.stringify([{ id: a.id, kind: 'automation', label: a.name }])
        );
      }}
      onClick={(event) => {
        if (!fromControl(event)) onOpen(a);
      }}
      onKeyDown={(event) => openKey(event, () => onOpen(a))}
      title={a.prompt}
    >
      <span className={styles.text}>
        <span className={styles.name}>{a.name}</span>
        <span className={styles.meta}>{automationRowMeta(a)}</span>
      </span>
      {a.running && <RunningBadge />}
      <RowToggle automation={a} />
    </TreeRow>
  );

  const renderScript = (script: HookWorkspaceInfo) => {
    const name = script.hookName;
    const enabled = enabledByName.get(name);
    const build = buildByName.get(name);
    const note = buildNote(build);
    const sentence = scriptSentence(name, declaredByName.get(name));
    return (
      <TreeRow
        key={`script:${name}`}
        as="div"
        role="treeitem"
        tabIndex={0}
        depth={1}
        chevron="empty"
        active={activeScriptName === name}
        aria-selected={activeScriptName === name}
        reveal={pulseId === name}
        dimmed={enabled !== true}
        data-inspect-name={name}
        data-inspect-id={name}
        data-reveal-id={name}
        data-testid={`script-row-${name}`}
        // Drags into a pane split, like a tool or a doc.
        paneSelection={{ kind: 'hook', hook: script }}
        onDragStart={(event) => {
          // The tree-node mime lets the archive drop zone offer move-to-Trash.
          event.dataTransfer.setData(TREE_NODE_MIME, JSON.stringify([{ id: name, kind: 'hook' }]));
        }}
        onClick={(event) => {
          if (!fromControl(event)) onScriptOpen(script);
        }}
        onKeyDown={(event) => openKey(event, () => onScriptOpen(script))}
        title={name}
      >
        <span className={styles.text}>
          <span className={styles.name}>{name}</span>
          <span className={styles.meta}>
            {sentence}
            {note && (
              <>
                {' · '}
                <span
                  className={build?.status === 'failed' ? styles.buildFailed : undefined}
                  title={build?.lastError ?? undefined}
                >
                  {note}
                </span>
              </>
            )}
          </span>
        </span>
        {enabled !== undefined && (
          <Switch
            checked={enabled}
            onChange={(next) => void scriptsState.setEnabled(name, next)}
            disabled={toggling.has(name)}
            onLabel="On"
            offLabel="Off"
            aria-label={`Run ${name} automatically`}
            title={
              enabled ? 'Runs on its events and schedules' : 'Off: runs only from its test console'
            }
          />
        )}
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          className={styles.rowBtn}
          onClick={() => onScriptOpen(script)}
          title="Edit script"
          aria-label={`Edit ${name}`}
        >
          <EditIcon />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          className={styles.deleteBtn}
          onClick={() => setDeleteTarget(script)}
          title="Move script to Trash"
          aria-label={`Delete ${name}`}
        >
          <TrashIcon />
        </Button>
      </TreeRow>
    );
  };

  const listError = [error, scriptsState.error].filter(Boolean).join(' ');

  return (
    <SidebarView
      title="Automations"
      actions={
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className={styles.addBtn}
          onClick={openCreateMenu}
          title="New automation or script"
          aria-label="New automation or script"
          aria-haspopup="menu"
          aria-expanded={createMenu !== null}
        >
          +
        </Button>
      }
    >
      {listError && (
        <div className={styles.error} role="alert">
          {listError}
        </div>
      )}
      {scriptsState.toggleError && (
        <div className={styles.error} role="alert">
          {scriptsState.toggleError}
        </div>
      )}
      {!ready && listed === 0 && !listError && <div className={styles.note}>Loading…</div>}
      {ready && listed === 0 && (
        <div className={styles.note}>
          No automations yet. Agents create them when you ask for a reminder or a schedule, or press
          +.
        </div>
      )}
      <Tree
        data-sidebar-mounted={
          !ready ? 'loading' : automations === null || scripts === null ? 'error' : 'ready'
        }
        aria-label="Automations"
        ref={treeRef}
        onKeyDown={onTreeKeyDown}
      >
        {groups.map((group) => (
          <TreeGroup
            headerProps={{
              'data-sidebar-disclosure': '',
              ref: mountedDisclosure((open) => setGroupOpen(group.id, open)),
            }}
            key={group.id}
            label={group.label}
            count={group.rows.length}
            open={!closed.has(group.id)}
            onToggle={() => setGroupOpen(group.id, closed.has(group.id))}
          >
            {group.rows.map((row) =>
              row.kind === 'automation'
                ? renderAutomation(row.automation)
                : renderScript(row.script)
            )}
          </TreeGroup>
        ))}
        {ready && (
          <TreeGroup
            headerProps={{
              'data-sidebar-disclosure': '',
              ref: mountedDisclosure((open) => setGroupOpen('runs', open)),
            }}
            label="Recent runs"
            open={!closed.has('runs')}
            onToggle={() => setGroupOpen('runs', closed.has('runs'))}
          >
            <AutomationsRunLog
              automations={listedAutomations}
              onOpenAutomation={onOpen}
              onOpenScript={openScriptByName}
            />
          </TreeGroup>
        )}
      </Tree>
      {createMenu && (
        <ContextMenu
          ariaLabel="New automation or script"
          x={createMenu.x}
          y={createMenu.y}
          // Each also drags into a pane split, opening its form there.
          items={[
            {
              label: 'New automation',
              onSelect: onCreate,
              onDragStart: (event) => dragSelection(event, { kind: 'automation-create' }),
            },
            {
              label: 'New script',
              onSelect: onScriptCreate,
              onDragStart: (event) => dragSelection(event, { kind: 'hook-create' }),
            },
          ]}
          onClose={() => setCreateMenu(null)}
        />
      )}
      {deleteTarget && (
        <MoveHookToTrashModal
          variant="delete"
          hookName={deleteTarget.hookName}
          onTrashed={() => {
            scriptsState.removed(deleteTarget.hookName);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </SidebarView>
  );
};
