import { useRef, useState, type FC, type FormEvent, type KeyboardEvent } from 'react';
import { formatTableName, getErrorMessage, tableNameProblem } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import { emitTableEvent, projectNameOf, useProjectList } from '@desktop/features/database';
import { tablesApi } from '@desktop/utils/api';
import type { Editor } from '@tiptap/core';
import { TableInput } from './TableInput';
import { TableGrid } from './TableGrid';
import styles from './TableView.module.scss';

interface TableDraftViewProps {
  /** Client-minted catalog id; reused on every retry so creates are idempotent. */
  draftId: string;
  /**
   * Project the table is created in (sent as `projectId`, so it lands at the
   * bottom of that project's Tables group in the same request); null or
   * absent creates it workspace-wide.
   */
  projectId?: string | null;
}

/** "New table", plus the project's name once the shared project list has it. */
const ProjectDraftMeta: FC<{ projectId: string }> = ({ projectId }) => {
  const { projects } = useProjectList();
  const name = projectNameOf(projects, projectId);
  return <span>{name ? `New table · ${name}` : 'New table'}</span>;
};

/**
 * An unsaved table, named in place. Enter (or Create table) submits once;
 * Escape (or Cancel) discards the draft without touching the server. On
 * success the Dashboard promotes this pane to the saved table's view; on
 * failure the draft and typed name stay put with the server's message.
 */
export const TableDraftView: FC<TableDraftViewProps> = ({ draftId, projectId = null }) => {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Ref guard: a burst of Enter presses lands before `saving` re-renders.
  const inFlightRef = useRef(false);
  const inputRef = useRef<Editor | null>(null);

  const problem = tableNameProblem(name);
  // An empty name only complains once the user tries to create; other
  // validation errors appear as soon as the user types.
  const visibleProblem = problem && (attempted || name.trim().length > 0) ? problem : null;

  const submit = async () => {
    if (inFlightRef.current) return;
    setAttempted(true);
    if (problem) return;
    inFlightRef.current = true;
    setSaving(true);
    setServerError(null);
    try {
      const { table } = await tablesApi.create(
        projectId
          ? { id: draftId, name: name.trim(), projectId }
          : { id: draftId, name: name.trim() }
      );
      emitTableEvent({ type: 'table.created', table });
    } catch (err) {
      setServerError(getErrorMessage(err, 'Failed to create table'));
      setSaving(false);
      inFlightRef.current = false;
      inputRef.current?.commands.focus();
    }
  };

  const discard = () => {
    if (inFlightRef.current) return;
    emitTableEvent({ type: 'draft.discarded', draftId });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      discard();
      return;
    }
  };

  return (
    <div className={styles.shell}>
      <form className={styles.header} onSubmit={onSubmit} aria-label="New table" noValidate>
        <div className={styles.meta}>
          {projectId ? <ProjectDraftMeta projectId={projectId} /> : <span>New table</span>}
        </div>
        <div className={styles.titleRow}>
          <div className={styles.titleField}>
            <TableInput
              autoFocus
              onEditorReady={(editor) => {
                inputRef.current = editor;
              }}
              className={styles.titleInput}
              value={name}
              placeholder="table_name (lowercase, numbers, underscores)"
              ariaLabel="Table name"
              format={formatTableName}
              disabled={saving}
              error={serverError ?? visibleProblem ?? undefined}
              onChange={(value) => {
                setName(value);
                setServerError(null);
              }}
              onSubmit={() => void submit()}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className={styles.actions}>
            <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={saving || problem !== null}
              loading={saving}
              loadingText="Creating…"
            >
              Create table
            </Button>
          </div>
        </div>
      </form>
      <div className={styles.body}>
        <TableGrid
          columns={[]}
          emptyTitle="No entries yet"
          emptyNote="Name the table and press Enter to create it."
        />
      </div>
    </div>
  );
};
