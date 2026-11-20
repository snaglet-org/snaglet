import type { FC } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { TableIcon } from '@desktop/components/Icons';
import { sortTablesByOrder, tablesOfProject } from '@desktop/features/database/tableGroups';
import { useTableCatalog } from '@desktop/features/database/useTableCatalog';
import { clearChipDragPayload, setChipDragPayload } from '@desktop/utils/nodeChip';
import styles from './ContainerView.module.scss';
import { ProjectPaneSection } from './ProjectPaneSection';

interface ProjectTablesSectionProps {
  projectId: string;
  /** Opens the table's pane. Absent when the host has no pane to open into. */
  onOpenTable?: (table: TableCatalogEntry) => void;
}

/**
 * ProjectTablesSection — the Tables block of a project pane: the Database
 * catalog entries whose `projectId` is this project, in their manual order
 * (the order the sidebar draws them). Tables are not workspace nodes, so they
 * come from the table catalog (shared with the Database sidebar, so
 * link/unlink and renames update live), not the tree.
 */
export const ProjectTablesSection: FC<ProjectTablesSectionProps> = ({ projectId, onOpenTable }) => {
  const { tables, error } = useTableCatalog(true);
  const linked = tables ? sortTablesByOrder(tablesOfProject(tables, projectId)) : null;
  const empty =
    error ?? (tables === null ? 'Loading tables…' : 'No tables linked to this project.');

  return (
    <ProjectPaneSection title="Tables" items={linked} empty={empty}>
      {(visible) => (
        <div className={styles.list}>
          {visible.map((table) => (
            <button
              key={table.id}
              type="button"
              className={`${styles.listRow} ${styles['kind-table']}`}
              onClick={() => onOpenTable?.(table)}
              disabled={!onOpenTable}
              // Drag a table onto a pane edge to open it in a split, or into a
              // composer/doc as a chip (same payload as the sidebar rows).
              draggable
              onDragStart={(e) =>
                setChipDragPayload(e, {
                  chip: { id: table.id, kind: 'table', title: table.name },
                  dragLabel: table.name,
                  paneSelection: { kind: 'table', table_id: table.id, table },
                })
              }
              onDragEnd={() => clearChipDragPayload()}
            >
              <span className={styles.rowIcon} aria-hidden>
                <TableIcon />
              </span>
              <span className={styles.rowLabel}>{table.name}</span>
              <span className={styles.rowChevron} aria-hidden>
                ›
              </span>
            </button>
          ))}
        </div>
      )}
    </ProjectPaneSection>
  );
};
