import { useEffect, useRef } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  containersApi,
  docsApi,
  type ContainerTreeNode,
  type DocTreeNode,
} from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { showToast } from '@desktop/utils/toast';
import { recordCreate } from '@desktop/features/workspace-tree/undo/workspaceUndo';

const NEW_DOC_TITLE = 'Untitled doc';
const NEW_CONTAINER_NAME = 'Untitled container';
export const NEW_THREAD_TITLE = 'New thread';

type QuickCreateKind = 'doc' | 'container' | 'thread';

const KIND_BY_KEY: Record<string, QuickCreateKind> = {
  d: 'doc',
  c: 'container',
  t: 'thread',
};

/** Create a workspace-level doc and return it as a tree node, ready to open. */
export async function createQuickDoc(): Promise<DocTreeNode> {
  const created = await docsApi.create({ title: NEW_DOC_TITLE, containerId: null });
  recordCreate({ id: created.id, kind: 'doc', label: NEW_DOC_TITLE, parentId: null });
  emitLibraryEvent({ type: 'tree-invalidated', ids: [] });
  return {
    kind: 'doc',
    id: created.id,
    containerId: created.containerId,
    title: created.title,
    content: created.content,
    sortOrder: created.sortOrder,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  };
}

/** Create a workspace-level container and return it as a tree node, ready to open. */
async function createQuickContainer(): Promise<ContainerTreeNode> {
  const created = await containersApi.create({ name: NEW_CONTAINER_NAME, parentId: null });
  recordCreate({ id: created.id, kind: 'container', label: NEW_CONTAINER_NAME, parentId: null });
  emitLibraryEvent({ type: 'tree-invalidated', ids: [] });
  return {
    kind: 'container',
    id: created.id,
    parentId: created.parentId,
    name: created.name,
    sortOrder: created.sortOrder,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
    children: [],
    category: created.category ?? null,
    folderPath: created.folderPath ?? null,
    githubUrl: null,
  };
}

const CREATE: Record<'doc' | 'container', () => Promise<DocTreeNode | ContainerTreeNode>> = {
  doc: createQuickDoc,
  container: createQuickContainer,
};

function quickCreateKindFor(event: KeyboardEvent): QuickCreateKind | null {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return null;
  return KIND_BY_KEY[event.key.toLowerCase()] ?? null;
}

/**
 * ⌘⇧D creates a workspace-level doc and ⌘⇧C a workspace-level container, each
 * opened in the active pane. ⌘⇧T asks which agents to add (a thread needs at
 * least one) through `onNewThread`. Global: they fire while typing too, so a
 * thought can become a doc from anywhere. Left alone while a modal is open. A
 * held key creates one item, and a second press waits for the first create to
 * finish.
 */
export function useQuickCreateHotkeys(
  openNode: (node: DocTreeNode | ContainerTreeNode) => void,
  onNewThread: () => void
): void {
  const openRef = useRef(openNode);
  openRef.current = openNode;
  const threadRef = useRef(onNewThread);
  threadRef.current = onNewThread;
  const busyRef = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const kind = quickCreateKindFor(event);
      if (!kind) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (event.repeat || busyRef.current) return;
      if (kind === 'thread') {
        threadRef.current();
        return;
      }
      busyRef.current = true;
      CREATE[kind]()
        .then((node) => openRef.current(node))
        .catch((err: unknown) => showToast(getErrorMessage(err, `Could not create the ${kind}`)))
        .finally(() => {
          busyRef.current = false;
        });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
