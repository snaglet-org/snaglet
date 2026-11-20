import { useId, type FC } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { Button, Popover, usePopover } from '@desktop/components';
import { CheckIcon, FolderIcon, LeafToggle } from '@desktop/components/Icons';
import { projectLabel, useProjectList, useTableProjectLink } from '@desktop/features/database';
import { moveMenuFocus } from './menuFocus';
import styles from './TableView.module.scss';

interface TableProjectControlProps {
  /** The pane's custom table; its `projectId` is the control's value. */
  table: TableCatalogEntry;
}

interface PickerOption {
  projectId: string | null;
  label: string;
}

const WORKSPACE_LABEL = 'Workspace';

/**
 * The table pane's project home: a toolbar control reading the current
 * project's name (or "Workspace" for an unlinked table) that opens a picker
 * of every project plus Workspace. Choosing one links or unlinks the table
 * through the shared project link; the server's refusal reads inline under
 * the control, and a change made anywhere else arrives as `table.updated`
 * and relabels the control through the pane's own entry.
 */
export const TableProjectControl: FC<TableProjectControlProps> = ({ table }) => {
  const { projects, error: projectsError } = useProjectList();
  const link = useTableProjectLink();
  const picker = usePopover();
  const errorId = useId();

  const currentLabel =
    table.projectId === null ? WORKSPACE_LABEL : projectLabel(table.projectId, projects);
  const saving = link.savingTableId === table.id;

  const options: PickerOption[] = [
    { projectId: null, label: WORKSPACE_LABEL },
    ...(projects ?? []).map((project) => ({ projectId: project.id, label: project.name })),
  ];

  const choose = (projectId: string | null) => {
    picker.close();
    void link.setProject(table, projectId);
  };

  return (
    <div className={styles.projectControl}>
      <div className={styles.projectAnchor}>
        <Button
          variant="ghost"
          size="sm"
          className={styles.projectTrigger}
          leftIcon={<FolderIcon />}
          rightIcon={<LeafToggle open={picker.open} className={styles.projectCaret} />}
          loading={saving}
          loadingText="Moving…"
          aria-label={`Project: ${currentLabel}`}
          aria-haspopup="menu"
          aria-describedby={link.error ? errorId : undefined}
          {...picker.triggerProps}
        >
          {currentLabel}
        </Button>
        <Popover
          open={picker.open}
          label="Table project"
          placement="floating"
          className={styles.projectPicker}
          {...picker.surfaceProps}
        >
          <div role="menu" aria-label="Table project" onKeyDown={moveMenuFocus}>
            {options.map((option) => {
              const checked = option.projectId === table.projectId;
              return (
                <button
                  key={option.projectId ?? WORKSPACE_LABEL}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  className={styles.projectOption}
                  autoFocus={checked}
                  onClick={() => choose(option.projectId)}
                >
                  <span className={styles.projectOptionCheck} aria-hidden>
                    {checked && <CheckIcon />}
                  </span>
                  <span className={styles.projectOptionLabel}>{option.label}</span>
                </button>
              );
            })}
            {projects === null && !projectsError && (
              <p className={styles.projectPickerNote}>Loading projects…</p>
            )}
            {projects === null && projectsError && (
              <p className={styles.projectPickerNote} role="alert">
                {projectsError}
              </p>
            )}
            {projects?.length === 0 && <p className={styles.projectPickerNote}>No projects yet.</p>}
          </div>
        </Popover>
      </div>
      {link.error && (
        <p id={errorId} className={styles.projectError} role="alert">
          {link.error}
        </p>
      )}
    </div>
  );
};
