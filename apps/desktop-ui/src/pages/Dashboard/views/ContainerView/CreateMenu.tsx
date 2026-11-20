import { useEffect, useRef, useState, type FC } from 'react';
import type { ContainerCategory } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { createPortal } from 'react-dom';
import { containersApi, docsApi, threadsApi } from '@desktop/utils/api';
import { fixedLayerScale, fixedLayerViewport, toFixedLayer } from '@desktop/utils/cssZoom';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { recordCreate } from '@desktop/features/workspace-tree/undo/workspaceUndo';
import { ThreadAgentPickerModal } from '@desktop/features/workspace-tree/ThreadAgentPickerModal';
import { CREATABLE_KINDS, type CreatableKind } from '@desktop/features/workspace-tree/types';
import styles from './ContainerView.module.scss';

// Right-click "create" popover for ContainerView, like the WorkspaceTree "+"
// picker but anchored to the cursor. Two stages: pick a kind (container,
// project, doc, and thread inside a project), then name it. "New project"
// creates a container with category='project'. A thread goes through
// ThreadAgentPickerModal once its title is committed, as in the tree.

interface CreateMenuProps {
  x: number;
  y: number;
  parentContainerId: string | null;
  /** Category of the surrounding container; only a project offers "New thread". */
  parentCategory: ContainerCategory | null;
  onClose: () => void;
  onError: (msg: string) => void;
}

type Stage =
  | { phase: 'picker' }
  | { phase: 'naming'; kind: CreatableKind }
  | { phase: 'agents'; title: string };

const MENU_LABEL: Record<CreatableKind, string> = {
  container: 'New container',
  project: 'New project',
  doc: 'New doc',
  thread: 'New thread',
};

function defaultNameFor(kind: CreatableKind): string {
  switch (kind) {
    case 'container':
      return 'New container';
    case 'project':
      return 'New project';
    case 'doc':
      return 'Untitled doc';
    case 'thread':
      return 'New thread';
  }
}

/** The error surfaced when a thread was created but some agents did not join it. */
function missingAgentsMessage(failedAgentIds: string[]): string {
  const count = failedAgentIds.length;
  return `Thread created without ${count} agent${count === 1 ? '' : 's'} — add them from the thread's Agents tab`;
}

const CreateMenu: FC<CreateMenuProps> = ({
  x,
  y,
  parentContainerId,
  parentCategory,
  onClose,
  onError,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState<Stage>({ phase: 'picker' });
  const [name, setName] = useState('');

  // Dismiss on outside click / Escape only while the picker/naming popover
  // (the `ref`'d div below) is mounted. In the 'agents' phase `ref.current` is
  // null, so every mousedown in ThreadAgentPickerModal would read as outside
  // and unmount the menu before the modal's click runs. The modal owns its
  // own dismissal (backdrop + Escape route to onCancel). Mirrors
  // useTreeCreator's `if (creator?.stage !== 'picker') return` guard.
  useEffect(() => {
    if (stage.phase === 'agents') return;
    const onDoc = (e: globalThis.MouseEvent) => {
      const t = e.target as Node | null;
      if (ref.current && t && ref.current.contains(t)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, stage.phase]);

  // Auto-focus the input when naming stage opens.
  useEffect(() => {
    if (stage.phase === 'naming' && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [stage]);

  // Threads attach to a project, so the kind is offered only inside one.
  const kinds = CREATABLE_KINDS.filter((kind) => kind !== 'thread' || parentCategory === 'project');

  const selectKind = (kind: CreatableKind) => {
    setName(defaultNameFor(kind));
    setStage({ phase: 'naming', kind });
  };

  const commitName = async () => {
    if (stage.phase !== 'naming') return;
    const trimmed = name.trim();
    if (!trimmed) {
      onClose();
      return;
    }
    const { kind } = stage;
    try {
      // Creates arm undo (Cmd/Ctrl+Z archives the fresh node); threads are
      // excluded from undo scope, matching the tree's inline-create flow.
      if (kind === 'container' || kind === 'project') {
        const created = await containersApi.create({
          name: trimmed,
          parentId: parentContainerId,
          ...(kind === 'project' ? { category: 'project' as const } : {}),
        });
        recordCreate({
          id: created.id,
          kind: 'container',
          label: trimmed,
          parentId: parentContainerId,
        });
      } else if (kind === 'doc') {
        const created = await docsApi.create({ title: trimmed, containerId: parentContainerId });
        recordCreate({ id: created.id, kind: 'doc', label: trimmed, parentId: parentContainerId });
      } else if (kind === 'thread') {
        // Threads need at least one agent → escalate to the agent picker
        // modal; the actual creation happens after agents are chosen.
        setStage({ phase: 'agents', title: trimmed });
        return;
      }
      emitLibraryEvent({
        type: 'tree-invalidated',
        ids: parentContainerId ? [parentContainerId] : [],
      });
    } catch (err: unknown) {
      onError(getErrorMessage(err, 'Create failed'));
    } finally {
      // Threads close themselves after the agent picker resolves.
      if (kind !== 'thread') onClose();
    }
  };

  const onAgentsChosen = async (agentIds: string[]) => {
    if (stage.phase !== 'agents') return;
    try {
      // The thread attaches to the surrounding project (the picker only
      // offers the kind there). Once it exists the menu closes even if some
      // agents did not join — a retry would create a duplicate — and the
      // shortfall is reported through the pane's error toast instead.
      const { failedAgentIds } = await threadsApi.createInProjectWithAgents(
        stage.title,
        parentContainerId,
        agentIds
      );
      emitLibraryEvent({
        type: 'tree-invalidated',
        ids: parentContainerId ? [parentContainerId] : [],
      });
      if (failedAgentIds.length > 0) onError(missingAgentsMessage(failedAgentIds));
    } catch (err: unknown) {
      onError(getErrorMessage(err, 'Thread creation failed'));
    } finally {
      onClose();
    }
  };

  if (stage.phase === 'agents') {
    return (
      <ThreadAgentPickerModal
        threadTitle={stage.title}
        onCancel={onClose}
        onCreate={onAgentsChosen}
      />
    );
  }

  // Clamp menu so it stays on-screen: the pointer and the viewport are rect
  // px, the 200px allowance is the menu's own CSS px, and the portal sits in
  // the root zoom (see utils/cssZoom).
  const scale = fixedLayerScale();
  const viewport = fixedLayerViewport();
  const place = toFixedLayer({
    left: Math.min(x, viewport.width - 200 * scale),
    top: Math.min(y, viewport.height - 200 * scale),
  });

  return createPortal(
    <div
      ref={ref}
      className={styles.contextMenu}
      style={{ ...place, position: 'fixed' }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {stage.phase === 'picker' &&
        kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            className={styles.contextMenuItem}
            onClick={() => selectKind(kind)}
          >
            {MENU_LABEL[kind]}
          </button>
        ))}

      {stage.phase === 'naming' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void commitName();
          }}
          style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={defaultNameFor(stage.kind)}
            style={{
              padding: '4px 6px',
              fontSize: 13,
              minWidth: 180,
            }}
          />
        </form>
      )}
    </div>,
    document.body
  );
};

export default CreateMenu;
