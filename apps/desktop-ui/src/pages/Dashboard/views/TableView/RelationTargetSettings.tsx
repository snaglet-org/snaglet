import { useId } from 'react';
import {
  TABLE_REFERENCE_KIND_NAMES,
  TABLE_REFERENCE_KINDS,
  type TableCatalogEntry,
  type TableFieldDefinition,
} from '@snaglet/shared/types';
import { capitalize, tableReferenceKindName } from '@snaglet/shared/utils';
import { Button, OptionToggle, OptionToggleRow } from '@desktop/components';
import { TableInput } from './TableInput';
import styles from './TableFieldEditor.module.scss';

interface Props {
  tableId: string;
  draft: TableFieldDefinition;
  /** The table picked by name or id, once it matches exactly one custom table. */
  resolvedTableId: string | null;
  customTables: readonly TableCatalogEntry[];
  tablesLoading: boolean;
  tablesError: string | null;
  onRetryTables: () => void;
  disabled: boolean;
  onChange: (value: Partial<TableFieldDefinition>) => void;
  onEscape: () => void;
}

/**
 * A relation's target: one of "Your tables" or one kind of Snaglet item ("In Snaglet":
 * docs, projects, … agents). Picking one clears the other. The list toggle
 * names what it holds ("Allow multiple docs").
 */
export function RelationTargetSettings({
  tableId,
  draft,
  resolvedTableId,
  customTables,
  tablesLoading,
  tablesError,
  onRetryTables,
  disabled,
  onChange,
  onEscape,
}: Props) {
  const headingId = useId();
  const kind = draft.referenceKind ?? null;
  return (
    <div className={styles.control} role="group" aria-labelledby={headingId}>
      <span id={headingId} className={styles.label}>
        Links to
      </span>
      <span className={styles.groupLabel}>Your tables</span>
      <TableInput
        label="Related table"
        onEscape={onEscape}
        value={draft.referenceTableId ?? ''}
        passIdOnly
        disabled={disabled}
        onChange={(referenceTableId) =>
          onChange({ referenceTableId: referenceTableId || null, referenceKind: null })
        }
        placeholder="Enter a custom table name or ID…"
      />
      <div className={styles.targets} aria-label="Custom tables">
        {customTables.map((table) => (
          <Button
            key={table.id}
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-pressed={!kind && resolvedTableId === table.id}
            onClick={() => onChange({ referenceTableId: table.id, referenceKind: null })}
          >
            {table.name}
            {table.id === tableId ? ' (this table)' : ''}
          </Button>
        ))}
      </div>
      {tablesLoading && <p className={styles.note}>Loading tables…</p>}
      {tablesError && (
        <div role="alert" className={styles.error}>
          {tablesError}{' '}
          <Button size="sm" onClick={onRetryTables}>
            Retry tables
          </Button>
        </div>
      )}
      <span className={styles.groupLabel}>In Snaglet</span>
      <div className={styles.targets} aria-label="Snaglet item types">
        {TABLE_REFERENCE_KINDS.map((option) => (
          <Button
            key={option}
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-pressed={kind === option}
            onClick={() => onChange({ referenceKind: option, referenceTableId: null })}
          >
            {capitalize(TABLE_REFERENCE_KIND_NAMES[option].plural)}
          </Button>
        ))}
      </div>
      <OptionToggleRow className={styles.optionRow}>
        <OptionToggle
          pressed={draft.multiple ?? false}
          disabled={disabled}
          onChange={(multiple) =>
            onChange({ multiple, nullable: !multiple, defaultValue: multiple ? [] : null })
          }
        >
          {`Allow multiple ${kind ? tableReferenceKindName(kind, true) : 'entries'}`}
        </OptionToggle>
      </OptionToggleRow>
    </div>
  );
}
