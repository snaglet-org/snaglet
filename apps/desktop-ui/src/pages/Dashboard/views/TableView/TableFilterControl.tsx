import { useId, type FC } from 'react';
import type { TableEntryWhere, TableEntryWhereOperator, TableField } from '@snaglet/shared/types';
import { Button, DateInput, Popover, Select, TextInput, usePopover } from '@desktop/components';
import { LeafToggle } from '@desktop/components/Icons';
import {
  defaultValue,
  filterOperators,
  isComplete,
  isFilterableField,
  needsValue,
  operatorLabel,
  valueText,
} from './tableFilterRules';
import { usePanePosition } from './usePanePosition';
import sortStyles from './TableSortControl.module.scss';
import styles from './TableFilterControl.module.scss';

interface TableFilterControlProps {
  fields: readonly TableField[];
  where: readonly TableEntryWhere[];
  onChange: (next: TableEntryWhere[]) => void;
}

/**
 * The table header's Filter button: conditions on fields, all of which an
 * entry must meet (AND). The operators and value input follow the field type.
 */
export const TableFilterControl: FC<TableFilterControlProps> = ({ fields, where, onChange }) => {
  const picker = usePopover();
  const labelId = useId();
  usePanePosition(picker.open, picker.triggerRef, picker.surfaceRef);
  const filterable = fields.filter(isFilterableField);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const active = where.filter((condition) => isComplete(condition, byId.get(condition.fieldId)));

  const update = (index: number, next: TableEntryWhere) =>
    onChange(where.map((condition, at) => (at === index ? next : condition)));
  const remove = (index: number) => onChange(where.filter((_, at) => at !== index));
  const add = () => {
    const field = filterable[0];
    if (!field) return;
    const operator = filterOperators(field)[0];
    onChange([...where, { fieldId: field.id, operator, value: defaultValue(field, operator) }]);
  };
  const changeField = (index: number, fieldId: string) => {
    const field = byId.get(fieldId);
    if (!field) return;
    const operator = filterOperators(field)[0];
    update(index, { fieldId, operator, value: defaultValue(field, operator) });
  };
  const changeOperator = (index: number, operator: TableEntryWhereOperator) => {
    const condition = where[index];
    const field = byId.get(condition.fieldId);
    if (!field) return;
    const keep = needsValue(operator) && needsValue(condition.operator);
    update(index, {
      fieldId: condition.fieldId,
      operator,
      value: keep ? condition.value : defaultValue(field, operator),
    });
  };

  return (
    <div className={sortStyles.anchor}>
      <Button
        variant="ghost"
        size="sm"
        className={active.length ? sortStyles.triggerActive : undefined}
        rightIcon={<LeafToggle open={picker.open} />}
        aria-haspopup="dialog"
        disabled={!filterable.length}
        title={filterable.length ? undefined : 'No filterable fields'}
        {...picker.triggerProps}
      >
        {active.length ? `Filter · ${active.length}` : 'Filter'}
      </Button>
      <Popover
        open={picker.open}
        label="Filter entries"
        role="dialog"
        placement="floating"
        className={`${sortStyles.panel} ${styles.panel}`}
        {...picker.surfaceProps}
      >
        <p id={labelId} className={sortStyles.hint}>
          {where.length ? 'Entries must match every filter.' : 'No filters. Every entry is shown.'}
        </p>
        {where.length > 0 && (
          <ol className={sortStyles.levels} aria-labelledby={labelId}>
            {where.map((condition, index) => {
              const field = byId.get(condition.fieldId);
              const operators = field ? filterOperators(field) : [];
              return (
                <li key={index} className={styles.condition}>
                  <Select
                    size="sm"
                    aria-label={`Filter ${index + 1} field`}
                    value={condition.fieldId}
                    onChange={(event) => changeField(index, event.target.value)}
                  >
                    {filterable.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    size="sm"
                    aria-label={`Filter ${index + 1} condition`}
                    value={condition.operator}
                    onChange={(event) =>
                      changeOperator(index, event.target.value as TableEntryWhereOperator)
                    }
                  >
                    {operators.map((operator) => (
                      <option key={operator} value={operator}>
                        {operatorLabel(field, operator)}
                      </option>
                    ))}
                  </Select>
                  {field && needsValue(condition.operator) ? (
                    <ValueInput
                      field={field}
                      index={index}
                      condition={condition}
                      onChange={(value) => update(index, { ...condition, value })}
                    />
                  ) : (
                    <span />
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    iconOnly
                    aria-label={`Remove filter ${index + 1}`}
                    onClick={() => remove(index)}
                  >
                    ×
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
        <div className={sortStyles.footer}>
          <Button variant="ghost" size="sm" disabled={!filterable.length} onClick={add}>
            + Add filter
          </Button>
          {where.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
        </div>
      </Popover>
    </div>
  );
};

const ValueInput: FC<{
  field: TableField;
  index: number;
  condition: TableEntryWhere;
  onChange: (value: string | boolean) => void;
}> = ({ field, index, condition, onChange }) => {
  const label = `Filter ${index + 1} value`;
  if (field.type === 'checkbox')
    return (
      <Select
        size="sm"
        aria-label={label}
        value={condition.value === false ? 'false' : 'true'}
        onChange={(event) => onChange(event.target.value === 'true')}
      >
        <option value="true">Checked</option>
        <option value="false">Unchecked</option>
      </Select>
    );
  if (field.type === 'select')
    return (
      <Select
        size="sm"
        aria-label={label}
        value={String(condition.value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option.label} value={option.label}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  // Dates compare by day, so both kinds pick a day.
  if (field.type === 'date' || field.type === 'datetime')
    return (
      <DateInput
        size="sm"
        aria-label={label}
        value={String(condition.value ?? '')}
        onChange={onChange}
      />
    );
  return (
    <TextInput
      size="sm"
      aria-label={label}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      placeholder={field.type === 'number' ? 'Number' : 'Value'}
      value={String(condition.value ?? '')}
      onChange={(event) => onChange(event.target.value)}
    />
  );
};

/**
 * The view's filters as pills under the header, next to the sorts: click a
 * pill to edit it in the Filter panel, × to remove it.
 */
export const TableFilterBar: FC<TableFilterControlProps> = ({ fields, where, onChange }) => {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const shown = where
    .map((condition, index) => ({ condition, index }))
    .filter(({ condition }) => isComplete(condition, byId.get(condition.fieldId)));
  if (!shown.length) return null;
  return (
    <ul className={sortStyles.bar} aria-label="Active filters">
      {shown.map(({ condition, index }) => {
        const field = byId.get(condition.fieldId);
        const name = field?.name ?? 'Field';
        const op = operatorLabel(field, condition.operator);
        const value = valueText(field, condition);
        return (
          <li key={index} className={`${sortStyles.pill} ${styles.pill}`}>
            <span className={styles.pillText} title={`${name} ${op} ${value}`.trim()}>
              <span className={sortStyles.pillName}>{name}</span>{' '}
              <span className={sortStyles.pillDirection}>{op}</span>
              {value && <span className={styles.pillValue}> {value}</span>}
            </span>
            <button
              type="button"
              className={sortStyles.pillRemove}
              aria-label={`Remove ${name} filter`}
              title="Remove filter"
              onClick={() => onChange(where.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </li>
        );
      })}
      {shown.length > 1 && (
        <li>
          <button type="button" className={sortStyles.barClear} onClick={() => onChange([])}>
            Clear filters
          </button>
        </li>
      )}
    </ul>
  );
};
