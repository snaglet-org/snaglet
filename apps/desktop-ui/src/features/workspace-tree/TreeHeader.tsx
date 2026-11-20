import { Button } from '@desktop/components';
import styles from './WorkspaceTree.module.scss';

interface TreeHeaderProps {
  /** Plain sidebar heading. */
  label: string;
  /** Hover title for the header `+`. */
  addTitle: string;
  /** Accessible name for the header `+`. */
  addLabel: string;
  onAdd: (anchor: HTMLElement) => void;
}

/**
 * The library sidebar's header bar: heading on the left, loud `+` on the
 * right. Shared by the Workspace tree and the Database catalog so both views
 * keep one header surface.
 */
export function TreeHeader({ label, addTitle, addLabel, onAdd }: TreeHeaderProps) {
  return (
    <div className={styles.header}>
      <span className={styles.headerLabel}>{label}</span>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        className={styles.addBtn}
        title={addTitle}
        aria-label={addLabel}
        onClick={(e) => {
          e.stopPropagation();
          onAdd(e.currentTarget);
        }}
      >
        +
      </Button>
    </div>
  );
}
