import { useId, type FC } from 'react';
import type { TableEntrySort, TableField } from '@snaglet/shared/types';
import { Button, Popover, Select, usePopover } from '@desktop/components';
import { LeafToggle } from '@desktop/components/Icons';
import { isSortableField } from './boardViewPreference';
import { directionLabels } from './tableSortRules';
import { usePanePosition } from './usePanePosition';
import styles from './TableSortControl.module.scss';

interface TableSortControlProps {
  fields: readonly TableField[];
  sort: readonly TableEntrySort[];
  onChange: (next: TableEntrySort[]) => void;
}

/**
 * The table header's Sort button and its levels. Levels apply top to bottom:
 * the first decides the order, each next one only breaks the ties left above
 * it. A field can be used once.
 */
export const TableSortControl: FC<TableSortControlProps> = ({ fields, sort, onChange }) => {
  const picker = usePopover();
  const labelId = useId();
  usePanePosition(picker.open, picker.triggerRef, picker.surfaceRef);
  const sortable = fields.filter(isSortableField);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const unused = sortable.filter((field) => !sort.some((level) => level.fieldId === field.id));

  const update = (index: number, patch: Partial<TableEntrySort>) =>
    onChange(sort.map((level, at) => (at === index ? { ...level, ...patch } : level)));
  const remove = (index: number) => onChange(sort.filter((_, at) => at !== index));
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= sort.length) return;
    const next = [...sort];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const add = () => {
    const field = unused[0];
    if (field) onChange([...sort, { fieldId: field.id, direction: 'asc' }]);
  };

  return (
    <div className={styles.anchor}>
      <Button
        variant="ghost"
        size="sm"
        className={sort.length ? styles.triggerActive : undefined}
        rightIcon={<LeafToggle open={picker.open} />}
        aria-haspopup="dialog"
        disabled={!sortable.length}
        title={sortable.length ? undefined : 'No sortable fields'}
        {...picker.triggerProps}
      >
        Sort
      </Button>
      <Popover
        open={picker.open}
        label="Sort entries"
        role="dialog"
        placement="floating"
        className={styles.panel}
        {...picker.surfaceProps}
      >
        <p id={labelId} className={styles.hint}>
          {sort.length
            ? 'Sorted top to bottom: each sort only orders entries tied on the ones above.'
            : 'No sorts. Entries show in the table’s own order.'}
        </p>
        {sort.length > 0 && (
          <ol className={styles.levels} aria-labelledby={labelId}>
            {sort.map((level, index) => {
              const field = byId.get(level.fieldId);
              const labels = directionLabels(field);
              const choices = sortable.filter(
                (candidate) =>
                  candidate.id === level.fieldId ||
                  !sort.some((other) => other.fieldId === candidate.id)
              );
              return (
                <li key={level.fieldId} className={styles.level}>
                  <Select
                    size="sm"
                    aria-label={`Sort ${index + 1} field`}
                    value={level.fieldId}
                    onChange={(event) => update(index, { fieldId: event.target.value })}
                  >
                    {choices.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    size="sm"
                    aria-label={`Sort ${index + 1} direction`}
                    value={level.direction}
                    onChange={(event) =>
                      update(index, { direction: event.target.value === 'desc' ? 'desc' : 'asc' })
                    }
                  >
                    <option value="asc">{labels.asc}</option>
                    <option value="desc">{labels.desc}</option>
                  </Select>
                  <span className={styles.levelActions}>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      aria-label={`Move ${field?.name ?? 'sort'} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      aria-label={`Move ${field?.name ?? 'sort'} down`}
                      disabled={index === sort.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      aria-label={`Remove ${field?.name ?? 'sort'}`}
                      onClick={() => remove(index)}
                    >
                      ×
                    </Button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div className={styles.footer}>
          <Button variant="ghost" size="sm" disabled={!unused.length} onClick={add}>
            + Add sort
          </Button>
          {sort.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
        </div>
      </Popover>
    </div>
  );
};

interface TableSortBarProps {
  fields: readonly TableField[];
  sort: readonly TableEntrySort[];
  onChange: (next: TableEntrySort[]) => void;
}

/**
 * The view's active sorts as pills under the header, in order: click a pill
 * to flip its direction, × to remove it. Hidden when nothing is sorted.
 */
export const TableSortBar: FC<TableSortBarProps> = ({ fields, sort, onChange }) => {
  if (!sort.length) return null;
  const byId = new Map(fields.map((field) => [field.id, field]));
  return (
    <ul className={styles.bar} aria-label="Active sorts">
      {sort.map((level, index) => {
        const field = byId.get(level.fieldId);
        const name = field?.name ?? 'Field';
        const label = directionLabels(field)[level.direction];
        return (
          <li key={level.fieldId} className={styles.pill}>
            <button
              type="button"
              className={styles.pillToggle}
              title={`Sorted ${label}. Click to reverse.`}
              aria-label={`${name}, ${label}. Reverse`}
              onClick={() =>
                onChange(
                  sort.map((other, at) =>
                    at === index
                      ? { ...other, direction: other.direction === 'asc' ? 'desc' : 'asc' }
                      : other
                  )
                )
              }
            >
              <span className={styles.pillArrow} aria-hidden>
                {level.direction === 'asc' ? '↑' : '↓'}
              </span>
              <span className={styles.pillName}>{name}</span>
              <span className={styles.pillDirection}>{label}</span>
            </button>
            <button
              type="button"
              className={styles.pillRemove}
              aria-label={`Remove ${name} sort`}
              title="Remove sort"
              onClick={() => onChange(sort.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </li>
        );
      })}
      {sort.length > 1 && (
        <li>
          <button type="button" className={styles.barClear} onClick={() => onChange([])}>
            Clear all
          </button>
        </li>
      )}
    </ul>
  );
};
