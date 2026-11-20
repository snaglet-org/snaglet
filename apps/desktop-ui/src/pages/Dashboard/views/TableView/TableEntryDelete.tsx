import { useEffect, useRef, useState } from 'react';
import type { TableEntry, TableEntryReferenceCount } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { ConfirmModal } from '@desktop/components/Modal';
import { FetchError, tablesApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';

interface Props {
  tableId: string;
  /** Frozen after pending edits are flushed, never silently rebased on retry. */
  entries: ReadonlyArray<Pick<TableEntry, 'id' | 'revision'>>;
  onDeleted: (ids: string[]) => void;
  onReload: () => void;
  onCancel: () => void;
  /**
   * Keyboard deletes (Backspace/Delete on checked rows) are undoable, so they
   * skip the plain confirm and delete straight away. The dialog still shows
   * when that delete hits a conflict: stale rows, or rows other entries link to.
   */
  immediate?: boolean;
}

function isIncomingReference(value: unknown): value is TableEntryReferenceCount {
  return (
    !!value &&
    typeof value === 'object' &&
    'tableId' in value &&
    typeof value.tableId === 'string' &&
    'tableName' in value &&
    typeof value.tableName === 'string' &&
    'fieldId' in value &&
    typeof value.fieldId === 'string' &&
    'fieldName' in value &&
    typeof value.fieldName === 'string' &&
    'count' in value &&
    typeof value.count === 'number' &&
    Number.isFinite(value.count) &&
    value.count > 0
  );
}

type Conflict =
  | { kind: 'references'; message: string; references: TableEntryReferenceCount[] }
  | { kind: 'stale'; message: string };

/** Destructive retries keep their original versions and require distinct consent for clearing links. */
export function TableEntryDelete({
  tableId,
  entries,
  onDeleted,
  onReload,
  onCancel,
  immediate = false,
}: Props) {
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const started = useRef(false);
  const count = entries.length;
  const label = `${count} ${count === 1 ? 'entry' : 'entries'}`;

  async function remove() {
    try {
      const response = await tablesApi.deleteEntries(tableId, {
        entryIds: entries.map((entry) => entry.id),
        expectedRevisions: Object.fromEntries(entries.map((entry) => [entry.id, entry.revision])),
        ...(conflict?.kind === 'references' ? { clearReferences: true } : {}),
      });
      onDeleted([...response.deletedIds, ...response.alreadyDeleted]);
    } catch (err) {
      if (err instanceof FetchError && err.status === 409) {
        const details = err.details;
        const message = getErrorMessage(
          err,
          'These entries changed. Reload and review before deleting.'
        );
        if (
          details &&
          typeof details === 'object' &&
          'references' in details &&
          Array.isArray(details.references)
        ) {
          const references = details.references.filter(isIncomingReference);
          if (references.length > 0 && references.length === details.references.length) {
            setConflict({ kind: 'references', message, references });
            if (conflict?.kind === 'references') throw err;
            return;
          }
        }
        setConflict({ kind: 'stale', message });
        return;
      }
      throw err;
    }
  }

  useEffect(() => {
    if (!immediate || started.current) return;
    started.current = true;
    remove().catch((err: unknown) => {
      showToast(getErrorMessage(err, 'Could not delete these entries.'), { durationMs: 4000 });
      onCancel();
    });
    // Runs once per mounted delete; `entries` is frozen for this mount.
  }, []);

  if (immediate && !conflict) return null;

  if (conflict?.kind === 'stale') {
    return (
      <ConfirmModal
        key="stale"
        title="Review changed entries"
        confirmLabel="Reload entries"
        onConfirm={() => {
          onReload();
          onCancel();
        }}
        onCancel={onCancel}
      >
        {[
          conflict.message,
          'Nothing was deleted. Reload, review your selection, then confirm again.',
        ]}
      </ConfirmModal>
    );
  }

  return (
    <ConfirmModal
      key={conflict?.kind ?? 'delete'}
      title={conflict ? 'Delete linked entries?' : `Delete ${label}?`}
      confirmLabel={conflict ? 'Clear links and delete' : 'Delete entries'}
      confirmingLabel="Deleting…"
      destructive
      onConfirm={remove}
      onCancel={onCancel}
    >
      {conflict
        ? [
            conflict.message,
            ...conflict.references.map(
              (reference) =>
                `${reference.tableName} · ${reference.fieldName}: ${reference.count} ${reference.count === 1 ? 'link' : 'links'}`
            ),
            `Delete ${label} and clear these links from other entries? This cannot be undone.`,
          ]
        : `Delete ${label} from this table? This cannot be undone.`}
    </ConfirmModal>
  );
}
