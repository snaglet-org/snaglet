import { useState, type FC, type FormEvent, type SyntheticEvent } from 'react';
import type { TableEntryWhere, TableEntryWhereOperator, TableField } from '@snaglet/shared/types';
import { Button, DateInput, Popover, Select, TextInput, usePopover } from '@desktop/components';
import { isComplete, needsValue, operatorLabel, valueText } from './tableFilterRules';
import {
  activeColumnCondition,
  clearColumnConditions,
  columnConditionCount,
  isPicked,
  quickChoices,
  setColumnCondition,
} from './tableHeaderFilterRules';
import { usePanePosition } from './usePanePosition';
import sortStyles from './TableSortControl.module.scss';
import styles from './TableView.module.scss';

interface TableHeaderFilterProps {
  field: TableField;
  label: string;
  /** The view's whole filter, incomplete conditions included (what the Filter control shows). */
  where: readonly TableEntryWhere[];
  onChange: (next: TableEntryWhere[]) => void;
  disabled?: boolean;
}

/** Keeps presses and keys in the header's filter from reaching the header (drag, Alt+Arrow). */
const contain = (event: SyntheticEvent) => event.stopPropagation();

/**
 * A filterable column header's one-click filter: a funnel that opens a small
 * popover for this column only (option picks for select and checkbox, an
 * operator and value for text, number and date, plus empty / not empty).
 * It edits the view's `where`, the same one the Filter control and filter
 * bar show, replacing only this column's condition. While the column is
 * filtered the funnel stays shown and a × beside it clears that column.
 */
export const TableHeaderFilter: FC<TableHeaderFilterProps> = ({
  field,
  label,
  where,
  onChange,
  disabled,
}) => {
  const picker = usePopover();
  usePanePosition(picker.open, picker.triggerRef, picker.surfaceRef);
  const active = activeColumnCondition(where, field);
  const count = columnConditionCount(where, field.id);
  const shown = active
    ? `${operatorLabel(field, active.operator)} ${valueText(field, active)}`
    : '';
  const accessibleName = active
    ? `${label} filter: ${shown.trim()}. Change filter`
    : `Filter ${label}`;

  const apply = (condition: TableEntryWhere) => {
    onChange(setColumnCondition(where, condition));
    picker.close();
  };
  const clear = () => onChange(clearColumnConditions(where, field.id));

  return (
    <span className={styles.headerFilter} data-column-control="" onPointerDown={contain}>
      <button
        {...picker.triggerProps}
        className={styles.filterToggle}
        data-filter-toggle=""
        data-active={active ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-label={accessibleName}
        aria-pressed={!!active}
        aria-disabled={disabled || undefined}
        title={active ? `${label} ${shown.trim()}` : `Filter ${label}`}
        onKeyDown={(event) => {
          // Enter/Space activate the button natively; keep Alt+Arrow off the header.
          if (event.key !== 'Escape') event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (!disabled) picker.toggle();
        }}
      >
        <FunnelIcon filled={!!active} />
      </button>
      {count > 0 && (
        <button
          type="button"
          className={styles.filterClear}
          data-filter-clear=""
          aria-label={`Clear ${label} filter`}
          title={`Clear ${label} filter`}
          aria-disabled={disabled || undefined}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (!disabled) clear();
          }}
        >
          ×
        </button>
      )}
      <Popover
        open={picker.open}
        label={`Filter ${label}`}
        role="dialog"
        placement="floating"
        className={`${sortStyles.panel} ${styles.headerFilterPanel}`}
        {...picker.surfaceProps}
      >
        <div
          onKeyDown={(event) => {
            if (event.key !== 'Escape') event.stopPropagation();
          }}
          onClick={contain}
        >
          <HeaderFilterBody field={field} label={label} active={active} onApply={apply} />
          {count > 0 && (
            <div className={sortStyles.footer}>
              <span />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  clear();
                  picker.close();
                }}
              >
                Clear filter
              </Button>
            </div>
          )}
        </div>
      </Popover>
    </span>
  );
};

const HeaderFilterBody: FC<{
  field: TableField;
  label: string;
  active: TableEntryWhere | undefined;
  onApply: (condition: TableEntryWhere) => void;
}> = ({ field, label, active, onApply }) => {
  const choices = quickChoices(field);
  const emptyPicks = (
    <div className={styles.headerFilterPicks} role="group" aria-label={`${label} empty or not`}>
      {choices.empty.map((pick) => (
        <Button
          key={pick.condition.operator}
          variant="ghost"
          size="sm"
          aria-pressed={isPicked(active, pick)}
          onClick={() => onApply(pick.condition)}
        >
          {pick.label}
        </Button>
      ))}
    </div>
  );
  return (
    <>
      {choices.kind === 'options' &&
        (choices.picks.length ? (
          <div className={styles.headerFilterPicks} role="group" aria-label={`${label} values`}>
            {choices.picks.map((pick) => (
              <Button
                key={pick.label}
                variant="ghost"
                size="sm"
                aria-pressed={isPicked(active, pick)}
                onClick={() => onApply(pick.condition)}
              >
                {pick.label}
              </Button>
            ))}
          </div>
        ) : (
          <p className={sortStyles.hint}>No options yet.</p>
        ))}
      {choices.kind === 'value' && (
        <ValueForm
          field={field}
          label={label}
          active={active}
          operators={choices.operators}
          onApply={onApply}
        />
      )}
      {choices.empty.length > 0 && emptyPicks}
    </>
  );
};

const ValueForm: FC<{
  field: TableField;
  label: string;
  active: TableEntryWhere | undefined;
  operators: TableEntryWhereOperator[];
  onApply: (condition: TableEntryWhere) => void;
}> = ({ field, label, active, operators, onApply }) => {
  const valued = active && needsValue(active.operator) && operators.includes(active.operator);
  const [operator, setOperator] = useState<TableEntryWhereOperator>(
    valued ? active.operator : operators[0]
  );
  const [value, setValue] = useState(valued ? String(active.value ?? '') : '');
  const condition: TableEntryWhere = { fieldId: field.id, operator, value };
  const ready = isComplete(condition, field);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onApply(condition);
  };
  const isDate = field.type === 'date' || field.type === 'datetime';
  return (
    <form className={styles.headerFilterForm} onSubmit={submit}>
      <Select
        size="sm"
        aria-label={`${label} condition`}
        value={operator}
        onChange={(event) => setOperator(event.target.value as TableEntryWhereOperator)}
      >
        {operators.map((candidate) => (
          <option key={candidate} value={candidate}>
            {operatorLabel(field, candidate)}
          </option>
        ))}
      </Select>
      {isDate ? (
        <DateInput size="sm" aria-label={`${label} value`} value={value} onChange={setValue} />
      ) : (
        <TextInput
          size="sm"
          aria-label={`${label} value`}
          autoFocus
          inputMode={field.type === 'number' ? 'decimal' : undefined}
          placeholder={field.type === 'number' ? 'Number' : 'Value'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      <Button type="submit" variant="primary" size="sm" disabled={!ready}>
        Apply
      </Button>
    </form>
  );
};

/** Bootstrap Icons `funnel-fill`; adding the hole gives `funnel`. */
const FUNNEL_PATH =
  'M1.5 1.5A.5.5 0 0 1 2 1h12a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.128.334L10 8.692V13.5a.5.5 0 0 1-.342.474l-3 1A.5.5 0 0 1 6 14.5V8.692L1.628 3.834A.5.5 0 0 1 1.5 3.5z';
const FUNNEL_HOLE_PATH =
  'm1 .5v1.308l4.372 4.858A.5.5 0 0 1 7 8.5v5.306l2-.666V8.5a.5.5 0 0 1 .128-.334L13.5 3.308V2z';

/**
 * Funnel glyph for the header filter (Bootstrap Icons `funnel`), drawn as
 * `funnel-fill` while the column is filtered. 12×12, currentColor.
 */
const FunnelIcon: FC<{ filled: boolean }> = ({ filled }) => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden
    focusable="false"
    data-filter-icon={filled ? 'active' : 'idle'}
  >
    <path d={filled ? FUNNEL_PATH : FUNNEL_PATH + FUNNEL_HOLE_PATH} />
  </svg>
);
