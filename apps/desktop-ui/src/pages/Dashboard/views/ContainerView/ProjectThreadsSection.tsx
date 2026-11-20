import type { FC, MouseEvent as ReactMouseEvent } from 'react';
import type { ThreadTreeNode } from '@desktop/utils/api';
import styles from './ContainerView.module.scss';
import { ListRow } from './ListRow';
import { ProjectPaneSection } from './ProjectPaneSection';

interface ProjectThreadsSectionProps {
  /**
   * The project's threads, in the order the tree payload nests them. The
   * server lists a project's threads in their manual order (`sortOrder`, with
   * last activity only breaking ties — `Threads.listAllOrdered`), and the
   * sidebar's Threads group trusts that order, so the pane does too rather
   * than re-sorting.
   */
  threads: readonly ThreadTreeNode[];
  renamingId: string | null;
  onOpen: (thread: ThreadTreeNode) => void;
  onContextMenu: (thread: ThreadTreeNode, e: ReactMouseEvent) => void;
  onCommitRename: (thread: ThreadTreeNode, value: string) => void;
  onCancelRename: () => void;
}

/**
 * ProjectThreadsSection — the Threads block of a project pane. A thread is
 * scoped to a project by `project_id` (never placed in a folder), so the
 * project pane lists them in their own section, in the server's manual
 * order, instead of mixing them into the folder/doc grid. Rows are the same
 * list rows the container list view uses, so rename, context menu and pane
 * drag all work the way they do for docs.
 */
export const ProjectThreadsSection: FC<ProjectThreadsSectionProps> = ({
  threads,
  renamingId,
  onOpen,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}) => {
  return (
    <ProjectPaneSection
      title="Threads"
      items={threads}
      empty="No threads in this project."
      keepVisible={(thread) => thread.id === renamingId}
    >
      {(visible) => (
        <div className={styles.list}>
          {visible.map((thread) => (
            <ListRow
              key={thread.id}
              node={thread}
              renaming={renamingId === thread.id}
              onClick={() => onOpen(thread)}
              onContextMenu={(e) => onContextMenu(thread, e)}
              onCommitRename={(value) => onCommitRename(thread, value)}
              onCancelRename={onCancelRename}
            />
          ))}
        </div>
      )}
    </ProjectPaneSection>
  );
};
