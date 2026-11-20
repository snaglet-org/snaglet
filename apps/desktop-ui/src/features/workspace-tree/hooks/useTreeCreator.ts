import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ContainerCategory } from '@snaglet/shared/constants';
import { containersApi, docsApi, tablesApi } from '../../../utils/api';
import { generateId } from '@snaglet/shared/utils';
import { emitTableEvent } from '../../database/tableEvents';
import { threadsApi } from '../../../utils/api/threads';
import { getErrorMessage } from '@snaglet/shared/utils';
import styles from '../WorkspaceTree.module.scss';
import { recordCreate } from '../undo/workspaceUndo';
import { ROOT_ITEMS_GROUP_ID, tablesGroupId, threadsGroupId } from '../treeUtils';
import { TREE_PICKER_KINDS, type CreatorState, type TreePickerKind } from '../types';

export interface UseTreeCreatorArgs {
  /** Expands the parent so the draft row + new item are visible. */
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  /** Bumps the tree refetch key after a successful create. */
  setReloadKey: Dispatch<SetStateAction<number>>;
  /** Surfaces a create failure without disturbing the tree. */
  reportError: (message: string) => void;
  /**
   * Opens a freshly created table in the active pane. Without it the picker
   * never offers a table (the tree is mounted outside a dashboard).
   */
  openTable?: (tableId: string) => void;
  /**
   * A node (doc, folder, project or thread) the name row created: the tree
   * selects its row and opens it in the active pane, as a click would. Only
   * called once the create succeeded.
   */
  onCreated?: (nodeId: string) => void;
}

/**
 * Threads and tables are offered only where they can live: at the workspace
 * root (a flat thread, an unlinked table) or inside a project (they attach to
 * it). Plain folders never hold either, so their picker omits both.
 */
const SCOPED_KINDS: ReadonlySet<TreePickerKind> = new Set(['thread', 'table']);
const KINDS_IN_SCOPE: readonly TreePickerKind[] = TREE_PICKER_KINDS;
const KINDS_IN_SCOPE_WITHOUT_TABLE: readonly TreePickerKind[] = TREE_PICKER_KINDS.filter(
  (kind) => kind !== 'table'
);
const KINDS_IN_FOLDER: readonly TreePickerKind[] = TREE_PICKER_KINDS.filter(
  (kind) => !SCOPED_KINDS.has(kind)
);

/** The error surfaced when a thread was created but some agents did not join it. */
function missingAgentsMessage(failedAgentIds: string[]): string {
  const count = failedAgentIds.length;
  return `Thread created without ${count} agent${count === 1 ? '' : 's'} — add them from the thread's Agents tab`;
}

/**
 * Inline create for the workspace tree: the two-stage `creator` state, from
 * `picker` (the kind menu the `+` buttons open) to `editing` (an inline draft
 * row). Commits (Enter or blur) call the kind's create API, bump the refetch
 * key and hand the new item over to open; Escape or a blank name cancels.
 * `openPicker` takes the parent's category to decide whether
 * a thread or table may be created there (see `creatableKinds`). Threads and
 * tables draft at the top of their scope's group; other root-level kinds
 * draft in "Docs & context", except a project.
 */
export function useTreeCreator({
  setExpanded,
  setReloadKey,
  reportError,
  openTable,
  onCreated,
}: UseTreeCreatorArgs) {
  const [creator, setCreator] = useState<CreatorState>(null);
  // Category of the container the open picker targets. Lives beside
  // `creator` because `CreatorState` only records the parent's id.
  const [parentCategory, setParentCategory] = useState<ContainerCategory | null>(null);
  const [pendingThread, setPendingThread] = useState<{
    title: string;
    projectId: string | null;
  } | null>(null);
  const draftInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the inline input the moment the editing draft row mounts.
  useEffect(() => {
    if (creator?.stage === 'editing' && draftInputRef.current) {
      draftInputRef.current.focus();
      draftInputRef.current.select();
    }
  }, [creator]);

  // Click-outside / Escape dismissal for the kind picker.
  useEffect(() => {
    if (creator?.stage !== 'picker') return;
    const onClick = (e: globalThis.MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest(`.${styles.picker}`)) return;
      if (target && target.closest(`.${styles.addBtn}`)) return;
      setCreator(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setCreator(null);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [creator]);

  const openPicker = (
    parentContainerId: string | null,
    anchor: HTMLElement,
    category: ContainerCategory | null = null
  ) => {
    const r = anchor.getBoundingClientRect();
    setParentCategory(category);
    setCreator({
      stage: 'picker',
      parentContainerId,
      anchorLeft: r.left,
      anchorTop: r.bottom + 4,
    });
  };

  const scopeAllowed =
    creator !== null && (creator.parentContainerId === null || parentCategory === 'project');
  const creatableKindsRaw = !scopeAllowed
    ? KINDS_IN_FOLDER
    : openTable
      ? KINDS_IN_SCOPE
      : KINDS_IN_SCOPE_WITHOUT_TABLE;
  const creatableKinds = creatableKindsRaw;

  const selectKind = (kind: TreePickerKind) => {
    if (!creator || creator.stage !== 'picker') return;
    if (kind === 'table' || kind === 'thread') {
      // Only a project scopes a thread or table; any other spot drafts a
      // workspace-level one. The name row opens at the top of that scope's group.
      const projectId = parentCategory === 'project' ? creator.parentContainerId : null;
      startScopedDraft(kind, projectId);
      return;
    }
    // Every kind goes to the name-prompt editing stage. Expand the parent (at
    // the root, the group the draft is drawn in) so the draft row + new item
    // are visible.
    const expandId = creator.parentContainerId ?? (kind === 'project' ? null : ROOT_ITEMS_GROUP_ID);
    if (expandId) setExpanded((prev) => new Set(prev).add(expandId));
    setCreator({
      stage: 'editing',
      parentContainerId: creator.parentContainerId,
      kind,
    });
  };

  /**
   * Opens the inline name row as the first row of a scope's Threads or Tables
   * group, expanding the group (and its project) so the row is visible.
   */
  const startScopedDraft = (kind: 'thread' | 'table', projectId: string | null) => {
    const groupId = kind === 'thread' ? threadsGroupId(projectId) : tablesGroupId(projectId);
    setExpanded((prev) => {
      const next = new Set(prev).add(groupId);
      if (projectId) next.add(projectId);
      return next;
    });
    setCreator({ stage: 'editing', parentContainerId: projectId, kind });
  };

  const cancelCreator = () => setCreator(null);

  const commitCreator = async (rawName: string) => {
    if (!creator || creator.stage !== 'editing') return;
    const name = rawName.trim();
    if (!name) {
      setCreator(null);
      return;
    }
    const draft = creator;
    setCreator(null);
    try {
      // Creates arm undo (Cmd/Ctrl+Z archives the fresh node). Threads are
      // deliberately excluded — undo scope is docs and containers only.
      if (draft.kind === 'container' || draft.kind === 'project') {
        const created = await containersApi.create({
          name,
          parentId: draft.parentContainerId,
          ...(draft.kind === 'project' ? { category: 'project' as const } : {}),
        });
        recordCreate({
          id: created.id,
          kind: 'container',
          label: name,
          parentId: draft.parentContainerId,
        });
        onCreated?.(created.id);
      } else if (draft.kind === 'doc') {
        const created = await docsApi.create({ title: name, containerId: draft.parentContainerId });
        recordCreate({
          id: created.id,
          kind: 'doc',
          label: name,
          parentId: draft.parentContainerId,
        });
        onCreated?.(created.id);
      } else if (draft.kind === 'table') {
        // A table is a catalog entry, not a tree node: the catalog event
        // repaints every Tables group, then the new table opens in the pane.
        const projectId = draft.parentContainerId;
        const { table } = await tablesApi.create(
          projectId
            ? { id: generateId('table'), name, projectId }
            : { id: generateId('table'), name }
        );
        emitTableEvent({ type: 'table.created', table });
        openTable?.(table.id);
        return;
      } else if (draft.kind === 'thread') {
        // A thread drafted under a project attaches to it; a root draft is
        // a flat thread. The picker only offers the kind in those two spots.
        setPendingThread({ title: name, projectId: draft.parentContainerId });
        return;
      }
      setReloadKey((v) => v + 1);
    } catch (err: unknown) {
      reportError(`Create failed: ${getErrorMessage(err)}`);
    }
  };

  const cancelPendingThread = () => setPendingThread(null);

  const commitPendingThread = async (agentIds: string[]) => {
    if (!pendingThread) return;
    if (agentIds.length === 0) {
      throw new Error('Select at least one agent');
    }
    // A failed create rejects, so the agent picker stays open and shows the
    // error itself — nothing was made, retrying is safe. Once the thread
    // exists the picker closes even if some agents did not join: a retry
    // would create a duplicate, so the shortfall is reported instead and
    // the tree reload reveals the new thread.
    const { thread, failedAgentIds } = await threadsApi.createInProjectWithAgents(
      pendingThread.title,
      pendingThread.projectId,
      agentIds
    );
    setPendingThread(null);
    // Opened even when an agent did not join: its Agents tab is the fix.
    onCreated?.(thread.id);
    setReloadKey((v) => v + 1);
    if (failedAgentIds.length > 0) reportError(missingAgentsMessage(failedAgentIds));
  };

  return {
    creator,
    /** Kinds the open picker should offer — threads and tables only at root or in a project. */
    creatableKinds,
    draftInputRef,
    pendingThread,
    openPicker,
    selectKind,
    startScopedDraft,
    cancelCreator,
    commitCreator,
    cancelPendingThread,
    commitPendingThread,
  };
}
