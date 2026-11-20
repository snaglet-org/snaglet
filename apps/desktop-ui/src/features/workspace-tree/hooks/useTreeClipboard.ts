/**
 * Cmd/Ctrl+C copy and Cmd/Ctrl+V paste for the workspace tree. Copy stashes
 * the selected node; paste asks the server to clone it recursively into the
 * selected container, else the copied node's own parent.
 *
 * The stash is module-level so a copy in the sidebar tree can be pasted in a
 * ContainerView folder grid and vice versa. The window listener acts only
 * when the keystroke targets a non-editable element and there is something
 * to copy or paste, so ordinary text copy/paste is never hijacked.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { cloneApi, type LibraryTreeChild } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { isProjectNode, labelOfNode, placementParentOf } from '../treeUtils';

interface ClipboardEntry {
  id: string;
  kind: LibraryTreeChild['kind'];
  label: string;
  /** The copied node's parent container (a thread's project) — the paste fallback target. */
  parentContainerId: string | null;
}

interface UseTreeClipboardArgs {
  selectedIds: Set<string>;
  selectionAnchorId: string | null;
  nodeIndex: Map<string, LibraryTreeChild>;
  setReloadKey: (fn: (v: number) => number) => void;
  setError: (msg: string | null) => void;
  /** Off when the tree body is hidden (search-only mode). Default on. */
  enabled?: boolean;
}

let clipboardEntry: ClipboardEntry | null = null;
const clipboardListeners = new Set<() => void>();

function notifyClipboard(): void {
  for (const listener of clipboardListeners) listener();
}

function setClipboardEntry(entry: ClipboardEntry | null): void {
  clipboardEntry = entry;
  notifyClipboard();
}

function subscribeClipboard(listener: () => void): () => void {
  clipboardListeners.add(listener);
  return () => clipboardListeners.delete(listener);
}

function getCanPaste(): boolean {
  return clipboardEntry !== null;
}

/** Test-only: reset the shared clipboard between test cases. */
export function __clearClipboardForTests(): void {
  setClipboardEntry(null);
}

/**
 * Where a paste of `entry` lands relative to `anchor` (the right-clicked or
 * selected row): into a container, otherwise beside the anchor in its
 * parent. A thread clones into a project scope only — the anchored
 * project, the anchored thread's project, or failing both its own project —
 * never into a plain folder.
 */
function pasteTargetFor(entry: ClipboardEntry, anchor: LibraryTreeChild): string | null {
  if (entry.kind !== 'thread') {
    return anchor.kind === 'container' ? anchor.id : placementParentOf(anchor);
  }
  if (anchor.kind === 'thread') return anchor.projectId;
  if (isProjectNode(anchor)) return anchor.id;
  return entry.parentContainerId;
}

/** True when the keystroke is aimed at a text-editing surface — leave it alone. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export function useTreeClipboard({
  selectedIds,
  selectionAnchorId,
  nodeIndex,
  setReloadKey,
  setError,
  enabled = true,
}: UseTreeClipboardArgs) {
  const canPaste = useSyncExternalStore(subscribeClipboard, getCanPaste);
  // Mirror the live args into refs so the single window listener always reads
  // fresh values without re-subscribing on every selection change.
  const selectedIdsRef = useRef(selectedIds);
  const anchorRef = useRef(selectionAnchorId);
  const indexRef = useRef(nodeIndex);
  selectedIdsRef.current = selectedIds;
  anchorRef.current = selectionAnchorId;
  indexRef.current = nodeIndex;

  /** Resolve the single "active" selected node (anchor, else first selected). */
  const activeSelectedNode = useCallback((): LibraryTreeChild | undefined => {
    const ids = selectedIdsRef.current;
    if (ids.size === 0) return undefined;
    const anchor = anchorRef.current;
    const id = anchor && ids.has(anchor) ? anchor : ids.values().next().value;
    return id ? indexRef.current.get(id) : undefined;
  }, []);

  /** Stash a specific node in the transient clipboard. Images are skipped
   *  (only docs / containers / threads clone). Returns false when nothing was
   *  stashed. Shared by the Cmd+C gesture and the context-menu "Copy" item. */
  const copyNode = useCallback((node: LibraryTreeChild | undefined | null): boolean => {
    if (!node || node.kind === 'image') return false;
    const label = labelOfNode(node) || 'Untitled';
    setClipboardEntry({
      id: node.id,
      kind: node.kind,
      label,
      parentContainerId: placementParentOf(node),
    });
    showToast(`"${label}" copied`);
    return true;
  }, []);

  const copySelected = useCallback(
    (): boolean => copyNode(activeSelectedNode()),
    [copyNode, activeSelectedNode]
  );

  /** Paste the stashed node into an explicit target container (`null` = root).
   *  The single clone call every paste path funnels through. */
  const pasteInto = useCallback(
    async (targetContainerId: string | null): Promise<void> => {
      const entry = clipboardEntry;
      if (!entry) return;
      try {
        const result = await cloneApi.clone({ sourceId: entry.id, targetContainerId });
        setError(null);
        setReloadKey((v) => v + 1);
        showToast(`"${result.root.title || entry.label}" pasted`);
      } catch (err) {
        setError(getErrorMessage(err, 'Paste failed'));
      }
    },
    [setReloadKey, setError]
  );

  /** Paste the stashed node relative to a specific node: into it when it's a
   *  container, otherwise beside it (into its parent). Used by the context
   *  menu, where the "active" node is the right-clicked row. */
  const pasteRelativeTo = useCallback(
    (node: LibraryTreeChild): Promise<void> => {
      const entry = clipboardEntry;
      return entry ? pasteInto(pasteTargetFor(entry, node)) : Promise.resolve();
    },
    [pasteInto]
  );

  const pasteClipboard = useCallback(async (): Promise<void> => {
    const entry = clipboardEntry;
    if (!entry) return;
    // Paste into the selected container; otherwise into the copied node's parent.
    const selNode = activeSelectedNode();
    const targetContainerId =
      selNode && selNode.kind === 'container'
        ? pasteTargetFor(entry, selNode)
        : entry.parentContainerId;
    await pasteInto(targetContainerId);
  }, [activeSelectedNode, pasteInto]);

  /** One-shot clone of a node beside the original (into its own parent), with
   *  no clipboard stash — the context menu "Duplicate" item. Reuses the same
   *  server clone call as paste. */
  const duplicateNode = useCallback(
    async (node: LibraryTreeChild): Promise<void> => {
      // Only docs / containers / threads clone (images are skipped).
      if (node.kind === 'image') return;
      const label = labelOfNode(node) || 'Untitled';
      try {
        const result = await cloneApi.clone({
          sourceId: node.id,
          targetContainerId: placementParentOf(node),
        });
        setError(null);
        setReloadKey((v) => v + 1);
        showToast(`"${result.root.title || label}" duplicated`);
      } catch (err) {
        setError(getErrorMessage(err, 'Duplicate failed'));
      }
    },
    [setReloadKey, setError]
  );

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // Embedded editors own their clipboard, even with a sidebar node selected.
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'c') {
        // The user has highlighted text somewhere in the document (rendered
        // docs, thread messages, …) → let the browser's native copy run, even
        // when a tree node is also selected. Hijacking Cmd+C here would stash
        // the tree node and the highlighted text would never reach the system
        // clipboard.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
        // Nothing selected → let the browser's native copy run.
        if (selectedIdsRef.current.size === 0) return;
        if (copySelected()) e.preventDefault();
      } else if (key === 'v') {
        // Nothing stashed → let native paste run.
        if (!clipboardEntry) return;
        e.preventDefault();
        void pasteClipboard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, copySelected, pasteClipboard]);

  return {
    copySelected,
    pasteClipboard,
    /** True when there is a stashed node available to paste — reactive across every mounted surface. */
    canPaste,
    copyNode,
    pasteRelativeTo,
    duplicateNode,
  };
}
