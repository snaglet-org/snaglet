import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { LeafToggle, PlusIcon } from '@desktop/components/Icons';
import { rowIndent } from './treeUtils';
import styles from './WorkspaceTree.module.scss';

export interface TreeGroupHeaderProps {
  /** Caption of the group — "Threads", "Tables", "Files", "Agents". */
  label: string;
  /** Rows under the group; hidden while `null`/`undefined` (still loading) or 0. */
  count?: number | null;
  open: boolean;
  onToggle: () => void;
  /** Indent level of the header; the rows under it sit one level deeper. */
  depth: number;
  /** Expansion key for `expanded`-set groups; also the `data-group-id` hook tests and reveal use. */
  groupId?: string;
  /** Paints the drop affordance while a drag the group accepts hovers it. */
  dropActive?: boolean;
  onDragOver?: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDrop?: (e: ReactDragEvent<HTMLDivElement>) => void;
  /**
   * Shows a `+` at the right of the header (revealed on hover or focus)
   * that creates something in the group's scope. Its click never toggles
   * the group.
   */
  onAdd?: () => void;
  /** Accessible name and tooltip of the `+`, e.g. "New table". */
  addLabel?: string;
}

/**
 * Header of a generated group in the workspace tree (Files, Threads, Tables
 * under a project, Agents under a thread, the workspace
 * Threads and Tables groups at the root). The header is itself a tree item — focusable, named
 * by its caption and count, expanded or collapsed — so a keyboard user
 * walks it like a folder row: Enter or Space toggles, Right opens, Left
 * closes. The chevron, caption and count share the folder rows' chrome.
 * With `onAdd` the header ends in a `+` button, a Tab stop of its own: its
 * keys and clicks stay with the button, so neither toggles the group.
 */
export function TreeGroupHeader({
  label,
  count,
  open,
  onToggle,
  depth,
  groupId,
  dropActive = false,
  onDragOver,
  onDragLeave,
  onDrop,
  onAdd,
  addLabel = 'New',
}: TreeGroupHeaderProps) {
  const showCount = typeof count === 'number' && count > 0;
  const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    onToggle();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Rows nested under the header own their own keys.
    if (e.target !== e.currentTarget) return;
    if (
      e.key === 'Enter' ||
      e.key === ' ' ||
      (e.key === 'ArrowRight' && !open) ||
      (e.key === 'ArrowLeft' && open)
    ) {
      e.preventDefault();
      onToggle();
    }
  };
  return (
    <div
      className={[styles.taskGroupHeader, dropActive ? styles.taskGroupHeaderDropActive : '']
        .filter(Boolean)
        .join(' ')}
      style={{ paddingLeft: rowIndent(depth) }}
      role="treeitem"
      aria-label={showCount ? `${label} (${count})` : label}
      aria-expanded={open}
      aria-level={depth + 1}
      tabIndex={0}
      data-group-id={groupId}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className={styles.chevron} aria-hidden>
        <LeafToggle open={open} className={styles.leafToggle} />
      </span>
      <span className={styles.taskGroupLabel} title={label}>
        {label}
      </span>
      {showCount && <span className={styles.taskGroupCount}>{count}</span>}
      {onAdd && (
        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.groupAddBtn}
            title={addLabel}
            aria-label={addLabel}
            onClick={(e: ReactMouseEvent<HTMLButtonElement>) => {
              e.stopPropagation();
              onAdd();
            }}
          >
            <PlusIcon />
          </button>
        </div>
      )}
    </div>
  );
}
