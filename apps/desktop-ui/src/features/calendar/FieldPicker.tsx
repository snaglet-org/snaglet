/**
 * Field picker: every *unbound* date / datetime field
 * across all active custom tables, grouped project → table → field, with a
 * search box. Snaglet's own `created_at` is listed too: it shows like any date,
 * read-only on the calendar. Picking one binds it to `calendarId` through the
 * field's binding write and records the step on the calendar undo stack
 * (toast + Cmd+Z).
 */
import { useEffect, useMemo, useState } from 'react';
import type { TableCatalogEntry, TableField } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { TextInput } from '@desktop/components';
import { tablesApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { useTableCatalog } from '@desktop/features/database/useTableCatalog';
import { projectNameOf, useProjectList } from '@desktop/features/database/projectList';
import { AnchoredSurface } from './AnchoredSurface';
import { bindFieldToCalendar } from './bindField';
import { loadCalendars } from './calendarStore';
import { offerUndo } from './calendarUndo';
import styles from './CalendarPopovers.module.scss';

export interface PickableField {
  table: TableCatalogEntry;
  field: TableField;
}

export interface FieldPickerGroup {
  projectId: string | null;
  projectName: string;
  tables: Array<{ table: TableCatalogEntry; fields: TableField[] }>;
}

/** Pure grouping + filtering (unit-tested). */
export function groupPickableFields(
  items: readonly PickableField[],
  query: string,
  projectName: (id: string) => string | null
): FieldPickerGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, FieldPickerGroup>();
  for (const { table, field } of items) {
    if (field.type !== 'date' && field.type !== 'datetime') continue;
    if (field.calendarId) continue;
    if (field.state) continue;
    if (q && !`${table.name} ${field.name}`.toLowerCase().includes(q)) continue;
    const pid = table.projectId ?? '';
    let group = groups.get(pid);
    if (!group) {
      group = {
        projectId: table.projectId,
        projectName: table.projectId ? (projectName(table.projectId) ?? 'Project') : 'Workspace',
        tables: [],
      };
      groups.set(pid, group);
    }
    let entry = group.tables.find((t) => t.table.id === table.id);
    if (!entry) {
      entry = { table, fields: [] };
      group.tables.push(entry);
    }
    entry.fields.push(field);
  }
  return [...groups.values()]
    .sort((a, b) =>
      a.projectId === null
        ? -1
        : b.projectId === null
          ? 1
          : a.projectName.localeCompare(b.projectName)
    )
    .map((g) => ({
      ...g,
      tables: g.tables.sort((a, b) => a.table.name.localeCompare(b.table.name)),
    }));
}

interface FieldPickerProps {
  anchor: HTMLElement;
  /** A calendar id, or 'default' (first run: bind to the Default calendar). */
  calendarId: string | 'default';
  calendarTitle: string;
  onClose: () => void;
  /** After a successful bind (before the popover closes). */
  onBound?: () => void;
}

export function FieldPicker({
  anchor,
  calendarId,
  calendarTitle,
  onClose,
  onBound,
}: FieldPickerProps) {
  const catalog = useTableCatalog(true);
  const { projects } = useProjectList();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PickableField[] | null>(null);
  /** Tables whose fields didn't load (the rest still list). */
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const tables = useMemo(
    () => (catalog.tables ?? []).filter((t) => t.origin === 'custom'),
    [catalog.tables]
  );

  useEffect(() => {
    if (!catalog.tables) return;
    let canceled = false;
    Promise.all(
      tables.map((table) =>
        tablesApi
          .fields(table.id)
          .then(({ fields }): PickableField[] => fields.map((field) => ({ table, field })))
          .catch(() => null)
      )
    )
      .then((lists) => {
        if (canceled) return;
        setItems(lists.flatMap((list) => list ?? []));
        setUnread(lists.filter((list) => list === null).length);
      })
      .catch((err: unknown) => {
        if (!canceled) setError(getErrorMessage(err, "Couldn't load fields"));
      });
    return () => {
      canceled = true;
    };
  }, [catalog.tables, tables]);

  const groups = useMemo(
    () => groupPickableFields(items ?? [], query, (id) => projectNameOf(projects, id)),
    [items, query, projects]
  );

  const pick = async ({ table, field }: PickableField) => {
    setBusy(field.id);
    try {
      const { step } = await bindFieldToCalendar(
        table.id,
        field.id,
        calendarId,
        `Show ${table.name} · ${field.name}`
      );
      await loadCalendars();
      onBound?.();
      onClose();
      // On the calendar undo stack (reverse binding write with revision, not table history).
      offerUndo(`Showing ${table.name} · ${field.name} on ${calendarTitle}`, {
        ...step,
        undo: () => step.undo().then(() => loadCalendars()),
        redo: () => step.redo!().then(() => loadCalendars()),
      });
    } catch (err) {
      setBusy(null);
      showToast(getErrorMessage(err, "Couldn't show that field"));
    }
  };

  const loading = !error && (items === null || catalog.tables === null);

  return (
    <AnchoredSurface anchor={anchor} label="Add a date field" onDismiss={onClose} width={320}>
      <div className={styles.pickerHead}>
        <TextInput
          size="sm"
          autoFocus
          placeholder="Search date fields"
          aria-label="Search date fields"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className={styles.pickerList} role="listbox" aria-label="Date fields">
        {loading && <p className={styles.muted}>Loading fields…</p>}
        {(error || catalog.error) && (
          <p className={styles.error} role="alert">
            {error ?? catalog.error}
          </p>
        )}
        {!loading && unread > 0 && (
          <p className={styles.error} role="alert">
            Couldn&apos;t load the fields of {unread === 1 ? '1 table' : `${unread} tables`}
          </p>
        )}
        {!loading && !error && unread === 0 && groups.length === 0 && (
          <p className={styles.muted}>
            {query ? 'No date fields match.' : 'Every date field is already on a calendar.'}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.projectId ?? 'workspace'} className={styles.pickerGroup}>
            <div className={styles.pickerProject}>{group.projectName}</div>
            {group.tables.map(({ table, fields }) => (
              <div key={table.id}>
                <div className={styles.pickerTable}>▦ {table.name}</div>
                {fields.map((field) => (
                  <button
                    key={field.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={styles.pickerField}
                    disabled={busy !== null}
                    onClick={() => void pick({ table, field })}
                  >
                    <span aria-hidden className={styles.pickerTypeIcon}>
                      {field.type === 'date' ? '▤' : '◷'}
                    </span>
                    <span>{field.name}</span>
                    <span className={styles.muted}>
                      {field.type === 'date' ? 'Date' : 'Date & time'}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </AnchoredSurface>
  );
}
