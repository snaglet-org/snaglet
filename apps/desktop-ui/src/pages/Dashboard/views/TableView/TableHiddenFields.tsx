import { type FC } from 'react';
import type { TableField } from '@snaglet/shared/types';
import { Button, Popover, usePopover } from '@desktop/components';
import { ShowIcon } from './TableGrid';
import { usePanePosition } from './usePanePosition';
import sortStyles from './TableSortControl.module.scss';
import styles from './TableView.module.scss';

interface TableHiddenFieldsProps {
  /** Fields hidden from the grid, in column order. */
  fields: readonly TableField[];
  /** Shows one hidden field again. */
  onShow: (field: TableField) => void;
  /** Field ids with a view write in flight. */
  pendingFieldIds?: ReadonlySet<string>;
  disabled?: boolean;
}

/**
 * Toolbar menu that lists the fields a header's eye-off button hid, and
 * shows them again one at a time or all at once. Renders nothing while every
 * field is shown.
 */
export const TableHiddenFields: FC<TableHiddenFieldsProps> = ({
  fields,
  onShow,
  pendingFieldIds,
  disabled,
}) => {
  const picker = usePopover();
  usePanePosition(picker.open, picker.triggerRef, picker.surfaceRef);
  if (!fields.length) return null;
  const label = `${fields.length} hidden ${fields.length === 1 ? 'field' : 'fields'}`;
  return (
    <div className={sortStyles.anchor}>
      <Button
        variant="ghost"
        size="sm"
        className={sortStyles.triggerActive}
        aria-haspopup="dialog"
        aria-label={`Hidden fields: ${label}`}
        disabled={disabled}
        {...picker.triggerProps}
      >
        {label}
      </Button>
      <Popover
        open={picker.open}
        label="Hidden fields"
        role="dialog"
        placement="floating"
        className={sortStyles.panel}
        {...picker.surfaceProps}
      >
        <p className={sortStyles.hint}>Hidden from the grid. Their values are kept.</p>
        <ul className={styles.hiddenFieldList}>
          {fields.map((field) => (
            <li key={field.id} className={styles.hiddenFieldRow}>
              <span className={styles.hiddenFieldName}>{field.name}</span>
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Show field ${field.name}`}
                disabled={disabled || pendingFieldIds?.has(field.id)}
                leftIcon={<ShowIcon />}
                onClick={() => onShow(field)}
              >
                Show
              </Button>
            </li>
          ))}
        </ul>
        {fields.length > 1 && (
          <div className={sortStyles.footer}>
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled || fields.some((field) => pendingFieldIds?.has(field.id))}
              onClick={() => fields.forEach(onShow)}
            >
              Show all
            </Button>
          </div>
        )}
      </Popover>
    </div>
  );
};
