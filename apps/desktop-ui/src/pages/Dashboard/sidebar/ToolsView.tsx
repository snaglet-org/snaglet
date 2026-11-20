import { mountedDisclosure } from '@desktop/ws/sidebarMounted';
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { toolsApi, toolWorkspacesApi, type ToolRow } from '@desktop/utils/api';
import { Chip } from '@desktop/components/Chip';
import { Button, Light, Select } from '@desktop/components';
import { Tree, TreeChildren, TreeRow } from '@desktop/components/SidebarTree';
import { ConfirmModal } from '@desktop/components/Modal';
import { EditIcon, ToolIcon, TrashIcon } from '@desktop/components/Icons';
import { toolIdFromSource } from '@desktop/components/ToolBuilderPanel';
import { CORE_TOOL_IDS } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { clearChipDragPayload, writeChipDragData } from '@desktop/utils/nodeChip';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { cn } from '@desktop/utils/classNames';
import { SidebarView } from './SidebarView';
import {
  TOOL_FILTERS,
  expansionKeysForTool,
  isToolFilter,
  matchesToolFilter,
  organizeTools,
  toolCount,
  type ToolFilter,
  type ToolGroup,
  type ToolSection,
} from './toolOrganization';
import styles from './ToolsView.module.scss';

interface ToolsViewProps {
  onToolCreate: () => void;
  /** Opens the tool's pane on its view/run face (ToolView) — plain row click. */
  onToolClick: (tool: ToolRow) => void;
  /**
   * Opens the tool's pane straight into the edit face (the pane-hosted
   * ToolBuilderPanel) — the row's Edit pencil.
   */
  onToolEdit: (tool: ToolRow) => void;
  onOpenProviders?: () => void;
  activeSelectionId?: string | null;
  revealNodeId?: string | null;
  revealNonce?: number;
}

const FILTER_STORAGE_KEY = 'snaglet.dashboard.toolsView.filter';
/** A stored expansion state, cleared on mount; categories always open collapsed. */
const LEGACY_EXPANDED_KEY = 'snaglet.dashboard.toolOrganization.expanded.v1';

/** Only workspace-sourced (GUI-buildable) tools get the Edit/Delete
 * affordances — builtin/mcp tools have no folder-as-source-of-truth for the
 * form to load or the delete flow to remove. */
function isWorkspaceTool(tool: ToolRow): boolean {
  return toolIdFromSource(tool.source) !== null;
}

/** The set-up chip a tool row shows when it can't run yet, if any. */
function setupLabel(tool: ToolRow): string | null {
  if (tool.availability === 'missing_credential') return 'Connect';
  if (tool.availability === 'integration_disabled') return 'Integration off';
  return null;
}

/** The viewer's All / Enabled / Disabled choice; All when unset or unreadable. */
function loadFilter(): ToolFilter {
  if (typeof window === 'undefined') return 'all';
  try {
    const stored = window.localStorage.getItem(FILTER_STORAGE_KEY);
    return isToolFilter(stored) ? stored : 'all';
  } catch {
    return 'all';
  }
}

function saveFilter(filter: ToolFilter): void {
  try {
    window.localStorage.setItem(FILTER_STORAGE_KEY, filter);
  } catch {
    // Persistence is optional; the choice still applies until the view closes.
  }
}

function forgetLegacyExpansion(): void {
  try {
    window.localStorage.removeItem(LEGACY_EXPANDED_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

function groupTools(group: ToolGroup): ToolRow[] {
  return [...group.tools, ...group.children.flatMap(groupTools)];
}

export const ToolsView: FC<ToolsViewProps> = ({
  onToolCreate,
  onToolClick,
  onToolEdit,
  onOpenProviders,
  activeSelectionId = null,
  revealNodeId = null,
  revealNonce = 0,
}) => {
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Every category starts collapsed each time the view opens; toggles last
  // until it closes.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<ToolFilter>(loadFilter);
  const [pulseId, setPulseId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Tool awaiting delete confirmation — renders the ConfirmModal when set. */
  const [deleteTarget, setDeleteTarget] = useState<ToolRow | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let canceled = false;
    toolsApi
      .list()
      .then((rows) => {
        if (!canceled) setTools(rows);
      })
      .catch((err) => !canceled && setError(getErrorMessage(err, 'Failed to load tools')))
      .finally(() => !canceled && setLoading(false));
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(forgetLegacyExpansion, []);

  // Categories with no tool matching the filter drop out: `organizeTools`
  // only builds sections and groups that hold a tool.
  const shownTools = useMemo(
    () => tools.filter((tool) => matchesToolFilter(tool, filter)),
    [tools, filter]
  );
  const sections = useMemo(() => organizeTools(shownTools), [shownTools]);

  // Reveal: list the tool, open its categories, then scroll to it and pulse
  // it. A request (id + nonce) is handled once: the effect also re-runs on
  // every change to `tools` (an enable toggle, a save, a delete), which must
  // not reset the filter, re-open categories or pulse again. Until the tool is
  // in the list the request stays pending. The timers live in a ref, not the
  // effect's cleanup, so such a re-run neither drops a pending scroll nor
  // restarts one; they are cleared when the view unmounts.
  const handledReveal = useRef<string | null>(null);
  const revealTimers = useRef<{ scroll: number | null; pulse: number | null }>({
    scroll: null,
    pulse: null,
  });
  useEffect(() => {
    if (!revealNodeId) return;
    const request = `${revealNodeId}:${revealNonce}`;
    if (handledReveal.current === request) return;
    const tool = tools.find((candidate) => candidate.id === revealNodeId);
    if (!tool) return;
    handledReveal.current = request;
    // A filter that hides the tool gives way to All for this visit only; the
    // viewer's saved choice is left as it was.
    setFilter((current) => (matchesToolFilter(tool, current) ? current : 'all'));
    setExpanded((previous) => {
      const next = { ...previous };
      for (const key of expansionKeysForTool(tool)) next[key] = true;
      return next;
    });
    const timers = revealTimers.current;
    if (timers.scroll !== null) window.clearTimeout(timers.scroll);
    if (timers.pulse !== null) window.clearTimeout(timers.pulse);
    timers.scroll = window.setTimeout(() => {
      const element = treeRef.current?.querySelector<HTMLElement>(
        `[data-reveal-id="${CSS.escape(revealNodeId)}"]`
      );
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setPulseId(revealNodeId);
      timers.pulse = window.setTimeout(() => setPulseId(null), 1600);
    }, 60);
  }, [revealNodeId, revealNonce, tools]);
  useEffect(() => {
    const timers = revealTimers.current;
    return () => {
      if (timers.scroll !== null) window.clearTimeout(timers.scroll);
      if (timers.pulse !== null) window.clearTimeout(timers.pulse);
      timers.scroll = timers.pulse = null;
      handledReveal.current = null; // a remount (StrictMode) handles the request afresh
    };
  }, []);

  // A key that was never toggled is absent from `expanded` and reads as
  // closed, so one click always flips what the user sees.
  const toggleExpanded = useCallback((key: string) => {
    setExpanded((previous) => ({ ...previous, [key]: !previous[key] }));
  }, []);

  const setOpen = useCallback((key: string, open: boolean) => {
    setExpanded((previous) => ({ ...previous, [key]: open }));
  }, []);

  const isOpen = useCallback((key: string) => expanded[key] ?? false, [expanded]);

  const renderCount = (shown: ToolRow[]) => {
    const count = toolCount(shown, filter);
    return (
      <span className={styles.count} title={count.title}>
        {count.text}
      </span>
    );
  };

  // Cross-pane sync, two events:
  //  - `tool-enabled-changed` — display-only enable/disable toggled from the
  //    tool's own pane (ToolView owns that switch).
  //  - `tool-saved` — full metadata saved from the pane-hosted
  //    ToolBuilderPanel. That form renders in the pane, not inside this
  //    component, so this listener is how a category/tier/description/etc.
  //    edit reaches the sidebar's own copy of the row without a refetch
  //    (`sections` re-groups from `tools` automatically once it changes),
  //    and how a tool made with Create tool joins the list.
  useEffect(
    () =>
      onLibraryEvent((event) => {
        if (event.type === 'tool-enabled-changed' && event.scope === 'tool') {
          setTools((rows) =>
            rows.map((row) =>
              row.id === event.id
                ? { ...row, enabled: event.enabled, availability: event.availability }
                : row
            )
          );
          return;
        }
        if (event.type === 'tool-saved') {
          setTools((rows) =>
            rows.some((row) => row.id === event.tool.id)
              ? rows.map((row) => (row.id === event.tool.id ? event.tool : row))
              : [...rows, event.tool]
          );
        }
      }),
    []
  );

  // Delete removes both halves of a workspace tool, in the order that fails
  // safe: the workspace folder first (the scanner's source of truth, see
  // FolderScanner/CustomToolScanner), then the DB row. A failed folder delete
  // stops there, since the next scan would re-register the row. If the row
  // delete then fails, the scanner's fs.watch pass disables the row within
  // ~400ms: degraded, but never orphaned or resurrected.
  //
  // Confirmation uses the in-app ConfirmModal: the Tauri webview suppresses
  // window.confirm (it returns falsy without showing).
  const handleDeleteTool = useCallback(async (tool: ToolRow) => {
    setDeleteError(null);
    setDeletingId(tool.id);
    try {
      const workspaceId = toolIdFromSource(tool.source);
      if (workspaceId) {
        await toolWorkspacesApi.delete(workspaceId);
      }
      await toolsApi.delete(tool.id);
      setTools((rows) => rows.filter((row) => row.id !== tool.id));
    } catch (err) {
      setDeleteError(getErrorMessage(err, 'Failed to delete tool'));
    } finally {
      setDeletingId(null);
    }
  }, []);

  const renderTool = (tool: ToolRow, depth: number) => {
    const blocked = tool.availability !== 'available' && tool.availability !== 'disabled';
    const setup = setupLabel(tool);
    const workspace = isWorkspaceTool(tool);
    return (
      <TreeRow
        key={tool.id}
        as="div"
        className={cn(
          styles.rowTool,
          setup && styles.rowNeedsSetup,
          workspace && styles.rowWorkspace
        )}
        active={activeSelectionId === tool.id}
        aria-selected={activeSelectionId === tool.id}
        reveal={pulseId === tool.id}
        dimmed={blocked}
        data-reveal-id={tool.id}
        data-inspect-id={tool.id}
        role="treeitem"
        depth={depth}
        chevron="empty"
        icon={<ToolIcon />}
        label={tool.name}
        paneSelection={{ kind: 'tool', tool }}
        onDragStart={(event) =>
          writeChipDragData(event.dataTransfer, { id: tool.id, kind: 'tool', title: tool.name })
        }
        onDragEnd={clearChipDragPayload}
        onClick={() => onToolClick(tool)}
        // The name can be truncated, so the tooltip always leads with it.
        title={tool.description ? `${tool.name}\n${tool.description}` : tool.name}
        trailing={
          <>
            <span
              className={`${styles.exposureBadge} ${
                CORE_TOOL_IDS.has(tool.id) ? styles.exposureCore : styles.exposureOnDemand
              }`}
              title={
                CORE_TOOL_IDS.has(tool.id)
                  ? 'Advertised to agents on every turn'
                  : 'Discovered by agents when needed'
              }
            >
              {CORE_TOOL_IDS.has(tool.id) ? 'Core' : 'On demand'}
            </span>
            {workspace && (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  className={styles.editBtn}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToolEdit(tool);
                  }}
                  // No editing a tool that's mid-delete; other rows stay live.
                  disabled={deletingId === tool.id}
                  title="Edit tool"
                  aria-label={`Edit ${tool.name}`}
                >
                  <EditIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  className={styles.deleteBtn}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteError(null);
                    setDeleteTarget(tool);
                  }}
                  // `loading` also disables (Button treats loading as disabled),
                  // scoped to this row — a delete in flight elsewhere doesn't
                  // freeze the rest of the tree. Empty loadingText: icon-only
                  // 16px button, spinner alone; the aria-label carries the name.
                  loading={deletingId === tool.id}
                  loadingText=""
                  title="Delete tool"
                  aria-label={`Delete ${tool.name}`}
                >
                  <TrashIcon />
                </Button>
              </>
            )}
            {setup && (
              <Chip
                size="xs"
                tone="warning"
                variant="outline"
                className={styles.setupChip}
                // Narrow rows fold the chip into a dot; the title keeps it legible.
                title={setup}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenProviders?.();
                }}
              >
                {setup}
              </Chip>
            )}
            <span
              className={styles.lightStatus}
              role="img"
              aria-label={tool.enabled ? `${tool.name} enabled` : `${tool.name} disabled`}
              title={tool.enabled ? 'Enabled' : 'Disabled'}
            >
              <Light color="white" on={tool.enabled} size={9} />
            </span>
          </>
        }
      />
    );
  };

  const renderGroup = (group: ToolGroup, depth: number) => {
    const open = isOpen(group.key);
    return (
      <div key={group.key} className={styles.group}>
        <TreeRow
          as="div"
          className={styles.rowGroup}
          depth={depth}
          role="treeitem"
          data-sidebar-disclosure=""
          ref={mountedDisclosure((open) => setOpen(group.key, open))}
          aria-expanded={open}
          chevron={{
            open,
            onToggle: () => toggleExpanded(group.key),
            'aria-label': open ? 'Collapse' : 'Expand',
          }}
          onClick={() => toggleExpanded(group.key)}
          label={group.label}
          trailing={renderCount(groupTools(group))}
        />
        {open && (
          <TreeChildren guideLeft={14 + depth * 14}>
            {group.children.map((child) => renderGroup(child, depth + 1))}
            {group.tools.map((tool) => renderTool(tool, depth + 1))}
          </TreeChildren>
        )}
      </div>
    );
  };

  const renderSection = (section: ToolSection) => {
    const open = isOpen(section.key);
    return (
      <div key={section.key} className={styles.section}>
        <TreeRow
          as="div"
          className={styles.rowSection}
          role="treeitem"
          data-sidebar-disclosure=""
          ref={mountedDisclosure((open) => setOpen(section.key, open))}
          aria-expanded={open}
          chevron={{
            open,
            onToggle: () => toggleExpanded(section.key),
            'aria-label': open ? 'Collapse' : 'Expand',
          }}
          onClick={() => toggleExpanded(section.key)}
          label={section.label}
          trailing={renderCount(section.tools)}
        />
        {open && (
          <TreeChildren>
            {section.groups.map((group) => renderGroup(group, 1))}
            {section.tools.length > 0 &&
              section.groups.length === 0 &&
              section.tools.map((tool) => renderTool(tool, 1))}
          </TreeChildren>
        )}
      </div>
    );
  };

  return (
    <SidebarView
      title="Tools"
      actions={
        <>
          <span className={styles.filter}>
            <Select
              size="sm"
              value={filter}
              onChange={(event) => {
                const next = event.target.value;
                if (!isToolFilter(next)) return;
                setFilter(next);
                saveFilter(next);
              }}
              aria-label="Show tools"
              title="Show tools"
            >
              {TOOL_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </span>
          {renderCount(shownTools)}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            className={styles.addBtn}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(PANE_ITEM_MIME, JSON.stringify({ kind: 'tool-create' }));
              event.dataTransfer.effectAllowed = 'all';
            }}
            onClick={onToolCreate}
            title="New tool"
            aria-label="New tool"
          >
            +
          </Button>
        </>
      }
    >
      <Tree
        data-sidebar-mounted={loading ? 'loading' : error ? 'error' : 'ready'}
        aria-label="Tool groups"
        ref={treeRef}
      >
        {loading && <div className={styles.placeholder}>Loading...</div>}
        {error && <div className={styles.error}>{error}</div>}
        {deleteError && (
          <div className={styles.error} role="alert">
            {deleteError}
          </div>
        )}
        {!loading && !error && sections.length === 0 && (
          <div className={styles.placeholder}>
            {tools.length === 0 ? 'No tools yet' : `No ${filter} tools`}
          </div>
        )}
        {!loading && !error && sections.map(renderSection)}
      </Tree>
      {deleteTarget && (
        <ConfirmModal
          title={`Delete "${deleteTarget.name}"?`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            // Close first, then run the delete; the row-level spinner
            // (`deletingId`) and the tree's `deleteError` alert carry the
            // in-flight and failure states.
            const tool = deleteTarget;
            setDeleteTarget(null);
            void handleDeleteTool(tool);
          }}
          onCancel={() => setDeleteTarget(null)}
        >
          This removes its workspace folder and cannot be undone.
        </ConfirmModal>
      )}
    </SidebarView>
  );
};
