import {
  useEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import {
  TABLE_FIELD_WIDTH_MAX,
  TABLE_FIELD_WIDTH_MIN,
  type TableColumnSummary,
  type TableEntrySort,
  type TableEntryWhere,
  type TableField,
} from '@snaglet/shared/types';
import { Tooltip } from '@desktop/components';
import { EyeIcon, EyeSlashIcon, LeafToggle, PlusIcon, TrashIcon } from '@desktop/components/Icons';
import {
  clearTableFieldDragPayload,
  setTableFieldDragPayload,
} from '@desktop/features/database/tableFieldDrag';
import { ColumnCalendarDot } from './ColumnCalendarDot';
import { FieldTypeIcon } from './FieldTypeIcon';
import { startColumnDrag } from './columnDrag';
import {
  clampColumnWidth,
  columnWidthStyle,
  COLUMN_RESIZE_STEP_PX,
  startColumnResize,
} from './columnResize';
import { rangeKindOf } from './dateRange';
import { isSortableField } from './boardViewPreference';
import { cycleColumnSort, directionLabels, nextSortDirection } from './tableSortRules';
import { isFilterableField } from './tableFilterRules';
import { TableHeaderFilter } from './TableHeaderFilter';
import { useScrollEdges } from '@desktop/hooks/useScrollEdges';
import styles from './TableView.module.scss';

interface TableGridProps {
  columns: TableColumnSummary[];
  fields?: TableField[];
  onEditField?: (field: TableField, trigger: HTMLButtonElement) => void;
  /**
   * Shows a trash handle on every custom (non-managed) column header: a
   * click calls this (archive or delete forever, asked by the pane), and
   * the handle drags to the sidebar trash to archive the column.
   */
  onRemoveField?: (field: TableField, trigger: HTMLButtonElement) => void;
  onAddField?: (trigger: HTMLButtonElement, beforeFieldId?: string) => void;
  /**
   * Gives every field header an eye-off button that hides the column from the
   * grid (the pane lists hidden fields in its toolbar to show them again). The
   * last shown column can't be hidden.
   */
  onHideField?: (field: TableField) => void;
  /**
   * Gives every expanded field column a resize handle on its right edge:
   * drag it, or Alt+←/→ with the handle focused, to set the width (whole px,
   * 64–800); double-click or Alt+0 calls this with null for auto. The drag
   * calls it once, on release.
   */
  onResizeField?: (field: TableField, width: number | null) => void;
  pendingFieldIds?: ReadonlySet<string>;
  fieldControlsDisabled?: boolean;
  fieldEditorId?: string;
  editingFieldId?: string;
  insertingFieldBoundary?: string;
  leadingHeader?: ReactNode;
  /** Widens the leading column for a row reference handle beside each checkbox. */
  wideLeading?: boolean;
  editingDisabled?: boolean;
  /** Called with every column name in the new order after a header drag. */
  onReorderColumns?: (columnNames: string[]) => void;
  /** The view's sort levels, shown on the headers' sort toggles. */
  sort?: readonly TableEntrySort[];
  /**
   * Gives every expanded sortable field header a sort toggle: a click steps
   * that column through ascending → descending → off as the only level, a
   * Shift-click adds it as one more level or steps the level it already is.
   * Called with the whole new sort.
   */
  onSortChange?: (sort: TableEntrySort[]) => void;
  /** The view's whole filter (incomplete conditions too), shown on the headers' filters. */
  where?: readonly TableEntryWhere[];
  /**
   * Gives every expanded filterable field header a one-click filter (see
   * TableHeaderFilter) that sets or clears that column's condition. Called
   * with the whole new filter.
   */
  onFilterChange?: (where: TableEntryWhere[]) => void;
  children?: ReactNode;
  /** Headline for metadata-only or empty tables. */
  emptyTitle?: ReactNode;
  emptyNote?: ReactNode;
}

function systemColumn(column: TableColumnSummary): 'id' | 'created_at' | undefined {
  return column.managed && (column.name === 'id' || column.name === 'created_at')
    ? column.name
    : undefined;
}

/** The resize handle on a field header's right edge. */
const RESIZE_HANDLE = '[data-column-resize]';

function columnWidth(column: TableColumnSummary, collapsed?: boolean): string | undefined {
  if (collapsed) return styles.collapsedColumn;
  const system = systemColumn(column);
  return system === 'id'
    ? styles.systemIdColumn
    : system === 'created_at'
      ? styles.systemDateColumn
      : undefined;
}

/**
 * Shared column headers and horizontal scroll boundary for table panes.
 * With `onReorderColumns`, headers drag sideways to reorder (see
 * `startColumnDrag`; a press without travel still opens the field) and
 * Alt+Arrow moves a focused field header. With `onResizeField`, each
 * expanded field's right edge resizes its column (see `startColumnResize`).
 */
export const TableGrid: FC<TableGridProps> = ({
  columns,
  fields,
  onEditField,
  onRemoveField,
  onAddField,
  onHideField,
  onResizeField,
  pendingFieldIds,
  fieldControlsDisabled,
  fieldEditorId,
  editingFieldId,
  insertingFieldBoundary,
  leadingHeader,
  wideLeading,
  editingDisabled,
  onReorderColumns,
  sort = [],
  onSortChange,
  where = [],
  onFilterChange,
  children,
  emptyTitle,
  emptyNote,
}) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  // Faded grid edges hint at columns scrolled out of view.
  const scrollEdges = useScrollEdges(scrollerRef);
  const suppressClick = useRef(false);
  const cancelDrag = useRef<(() => void) | null>(null);
  const cancelResize = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The column whose edge is being dragged, if any. */
  const [resizing, setResizing] = useState<string | null>(null);
  const [hoveredBoundary, setHoveredBoundary] = useState<string | null>(null);
  const [focusedBoundary, setFocusedBoundary] = useState<string | null>(null);
  const controlsDisabled = !!editingDisabled || !!fieldControlsDisabled;
  const reorderable =
    !!onReorderColumns &&
    !controlsDisabled &&
    !pendingFieldIds?.size &&
    !resizing &&
    columns.length > 1;
  const names = columns.map((column) => column.name);
  const fieldByColumn = new Map(fields?.map((field) => [field.columnName, field]));
  const hasLeadingHeader = leadingHeader !== undefined && leadingHeader !== null;
  const leadingClass = `${styles.selectionColumn} ${wideLeading ? styles.selectionColumnWide : ''}`;
  const allCollapsed =
    columns.length > 0 && columns.every((column) => fieldByColumn.get(column.name)?.collapsed);
  const shownFieldCount = columns.filter((column) => {
    const field = fieldByColumn.get(column.name);
    return field && !field.collapsed;
  }).length;
  // Once every column has a fixed size and one was set by hand (or is being
  // dragged), the table keeps those sizes instead of stretching them across
  // the pane.
  const sized = (column: TableColumnSummary) =>
    column.name === resizing || !!columnWidthStyle(fieldByColumn.get(column.name));
  const allFixed =
    columns.some(sized) &&
    columns.every(
      (column) =>
        sized(column) || !!fieldByColumn.get(column.name)?.collapsed || !!systemColumn(column)
    );
  const visibleBoundary = dragging || resizing ? null : (hoveredBoundary ?? focusedBoundary);

  useEffect(
    () => () => {
      cancelDrag.current?.();
      cancelResize.current?.();
    },
    []
  );

  /** The click that ends a header gesture must not open the field editor. */
  const swallowNextClick = () => {
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  const startDrag = (event: ReactPointerEvent<HTMLTableCellElement>, from: number) => {
    const scroller = scrollerRef.current;
    const table = tableRef.current;
    if (!reorderable || event.button !== 0 || !scroller || !table) return;
    if (event.target instanceof Element && event.target.closest('[data-column-control]')) return;
    cancelDrag.current?.();
    cancelDrag.current = startColumnDrag({
      scroller,
      table,
      from,
      startX: event.clientX,
      startY: event.clientY,
      onStart: () => {
        setDragging(true);
        setHoveredBoundary(null);
      },
      onDrop: (index, target) => {
        const next = [...names];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        // Commit before the preview transforms are cleared, so no frame
        // shows the previous order.
        flushSync(() => onReorderColumns?.(next));
      },
      onEnd: (dragged) => {
        cancelDrag.current = null;
        setDragging(false);
        if (dragged) swallowNextClick();
      },
    });
  };

  const resizeDisabled = controlsDisabled || dragging;

  const startResize = (
    event: ReactPointerEvent<HTMLElement>,
    field: TableField,
    columnName: string
  ) => {
    // Never the header's reorder drag, whatever happens below.
    event.stopPropagation();
    const table = tableRef.current;
    const header = event.currentTarget.closest('th');
    if (!onResizeField || resizeDisabled || event.button !== 0 || !table || !header) return;
    setHoveredBoundary(null);
    cancelResize.current?.();
    cancelResize.current = startColumnResize({
      table,
      column: columnName,
      header,
      startX: event.clientX,
      onStart: () => setResizing(columnName),
      onCancel: () => setResizing(null),
      // Render the new width before the live preview is cleared.
      onCommit: (width) => flushSync(() => onResizeField(field, width)),
      onEnd: (resized) => {
        cancelResize.current = null;
        setResizing(null);
        if (resized) swallowNextClick();
      },
    });
  };

  /** Alt+←/→ steps the width from what is drawn now; Alt+0 returns it to auto. */
  const onResizeKeyDown = (event: KeyboardEvent<HTMLElement>, field: TableField) => {
    if (!onResizeField || !event.altKey || event.ctrlKey || event.metaKey) return;
    // On macOS Alt+0 types "º", so match the physical key too.
    const reset = event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0';
    const step =
      event.key === 'ArrowLeft'
        ? -COLUMN_RESIZE_STEP_PX
        : event.key === 'ArrowRight'
          ? COLUMN_RESIZE_STEP_PX
          : 0;
    if (!reset && !step) return;
    event.preventDefault();
    event.stopPropagation();
    if (resizeDisabled) return;
    if (reset) {
      if (typeof field.width === 'number') onResizeField(field, null);
      return;
    }
    const current = field.width ?? event.currentTarget.closest('th')?.offsetWidth ?? 0;
    const next = clampColumnWidth(current + step);
    if (next !== field.width) onResizeField(field, next);
  };

  const onHeaderKeyDown = (event: KeyboardEvent<HTMLTableCellElement>, index: number) => {
    if (!reorderable || !event.altKey) return;
    if (
      event.target instanceof Element &&
      event.target.closest(`[data-field-insert], ${RESIZE_HANDLE}`)
    )
      return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const target = event.key === 'ArrowLeft' ? index - 1 : index + 1;
    if (target < 0 || target >= names.length) return;
    const next = [...names];
    [next[index], next[target]] = [next[target], next[index]];
    onReorderColumns?.(next);
  };

  const trackBoundary = (event: ReactPointerEvent<HTMLTableRowElement>) => {
    if (!onAddField || controlsDisabled || dragging || resizing || event.pointerType === 'touch')
      return;
    if (event.buttons) return;
    const target = event.target;
    if (
      target instanceof Element &&
      (target.closest(`[data-field-hide], ${RESIZE_HANDLE}`) || !target.closest('th[data-column]'))
    ) {
      setHoveredBoundary(null);
      return;
    }
    let nearest: string | null = null;
    let distance = 18;
    for (const button of event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[data-field-insert]'
    )) {
      const rect = button.getBoundingClientRect();
      const nextDistance = Math.abs(event.clientX - (rect.left + rect.width / 2));
      if (nextDistance < distance) {
        distance = nextDistance;
        nearest = button.dataset.fieldInsert ?? null;
      }
    }
    setHoveredBoundary(nearest);
  };

  /**
   * A sortable field header's sort toggle. Click steps the column through
   * ascending → descending → off as the only level; Shift-click (or
   * Shift+Enter / Shift+Space) adds it as a level or steps the one it is.
   * It never starts the header's drag or opens the field's settings.
   */
  const sortControl = (field: TableField, label: string) => {
    if (!onSortChange || !isSortableField(field)) return null;
    const level = sort.findIndex((item) => item.fieldId === field.id);
    const direction = level >= 0 ? sort[level].direction : undefined;
    const next = nextSortDirection(direction);
    const words = directionLabels(field);
    const action = next ? `Sort ${words[next]}` : 'Clear sort';
    const accessibleName = direction
      ? `${label} sorted ${words[direction]}${sort.length > 1 ? `, level ${level + 1}` : ''}. ${action}`
      : `Sort ${label} ${words.asc}`;
    const disabled = dragging || !!resizing;
    const apply = (additive: boolean) => {
      if (!disabled) onSortChange(cycleColumnSort(sort, field.id, additive));
    };
    return (
      <button
        type="button"
        className={styles.sortToggle}
        data-column-control=""
        data-sort-toggle=""
        data-active={direction ? 'true' : undefined}
        aria-label={accessibleName}
        aria-pressed={!!direction}
        aria-keyshortcuts="Shift+Enter"
        aria-disabled={disabled || undefined}
        title={`${accessibleName} — Shift-click to ${direction ? 'change this level' : 'add as another level'}`}
        onPointerDown={(event) => {
          setHoveredBoundary(null);
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          // Handle keyboard activation here so Shift is read reliably.
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) apply(event.shiftKey);
        }}
        onKeyUp={(event) => {
          if (event.key === ' ') event.preventDefault();
        }}
        onClick={(event) => {
          event.stopPropagation();
          apply(event.shiftKey);
        }}
      >
        {/* The leaf points down for ascending (A→Z reads downward), up for
            descending, and lies dim and sideways while unsorted. */}
        <span className={styles.sortLeaf} data-sort-direction={direction ?? 'none'} aria-hidden>
          <LeafToggle open={false} />
        </span>
        {direction && sort.length > 1 && (
          <span className={styles.sortLevel} aria-hidden="true">
            {level + 1}
          </span>
        )}
      </button>
    );
  };

  const insertControl = (field?: TableField) => {
    if (!onAddField) return null;
    const boundary = field?.id ?? 'append';
    const expanded = insertingFieldBoundary === boundary;
    const disabled =
      !expanded && (controlsDisabled || dragging || !!resizing || !!pendingFieldIds?.size);
    const label = field
      ? `Insert field before ${field.name}`
      : columns.length
        ? 'Add field at end'
        : 'Add first field';
    return (
      <button
        type="button"
        className={`${styles.fieldInsert} ${field ? styles.fieldInsertBefore : styles.fieldInsertAfter}`}
        data-column-control=""
        data-field-insert={boundary}
        data-visible={expanded || visibleBoundary === boundary || columns.length === 0}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={expanded ? fieldEditorId : undefined}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
        onFocus={() => setFocusedBoundary(boundary)}
        onBlur={() => setFocusedBoundary(null)}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          if (!disabled) onAddField(event.currentTarget, field?.id);
        }}
      >
        <PlusIcon />
      </button>
    );
  };

  return (
    <div>
      <div
        ref={scrollerRef}
        className={styles.gridContainer}
        {...scrollEdges}
        data-column-dragging={dragging || undefined}
        data-resizing-column={resizing ?? undefined}
        onScroll={() => setHoveredBoundary(null)}
      >
        <table
          ref={tableRef}
          className={`${styles.grid} ${allCollapsed || allFixed ? styles.gridCollapsed : ''}`}
        >
          <colgroup>
            {hasLeadingHeader && <col className={leadingClass} />}
            {columns.map((column) => (
              <col
                key={column.name}
                data-system-column={systemColumn(column)}
                className={columnWidth(column, fieldByColumn.get(column.name)?.collapsed)}
              />
            ))}
          </colgroup>
          <thead>
            <tr onPointerMove={trackBoundary} onPointerLeave={() => setHoveredBoundary(null)}>
              {hasLeadingHeader && (
                <th scope="col" className={`${styles.column} ${leadingClass}`}>
                  {leadingHeader}
                </th>
              )}
              {columns.length === 0 ? (
                <th scope="col" className={`${styles.column} ${styles.columnPlaceholder}`}>
                  No columns yet
                  {insertControl()}
                </th>
              ) : (
                columns.map((column, index) => {
                  const field = fieldByColumn.get(column.name);
                  const label = field?.name ?? column.name;
                  const collapsed = !!field?.collapsed;
                  const lastShown = !collapsed && shownFieldCount <= 1;
                  const pending = !!field && !!pendingFieldIds?.has(field.id);
                  const editing = !!field && field.id === editingFieldId;
                  const editDisabled = !editing && (controlsDisabled || pending || dragging);
                  // Managed columns (id, created_at) and the Name field never get the trash.
                  const removable =
                    !!field && !field.managed && !field.isTitle && !!onRemoveField && !collapsed;
                  const removeDisabled = controlsDisabled || pending || dragging;
                  const type = field?.type ?? column.dataType;
                  const typeLabel =
                    type === 'select' && field?.multiple
                      ? 'Multi-select'
                      : type === 'uuid'
                        ? 'UUID'
                        : (type === 'datetime'
                            ? 'Date and time'
                            : type.charAt(0).toUpperCase() + type.slice(1)) +
                          (rangeKindOf(field) ? ' range' : '');
                  const details = [
                    typeLabel,
                    // List fields (multiple relation/select) store an empty
                    // list rather than null, so non-nullable doesn't mean
                    // required there.
                    field && !field.managed && !field.nullable && !field.multiple && 'Required',
                    column.managed && 'Managed by Snaglet',
                    field?.description,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  const content = (
                    <span className={styles.columnContent}>
                      <span className={styles.typeIcon} data-field-type={type} aria-hidden="true">
                        <FieldTypeIcon type={type} />
                      </span>
                      <span className={styles.columnName}>{label}</span>
                      {field?.calendarId && <ColumnCalendarDot calendarId={field.calendarId} />}
                    </span>
                  );
                  const classes = [
                    styles.column,
                    column.managed && styles.columnManaged,
                    columnWidth(column, collapsed),
                    reorderable && styles.columnReorderable,
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <th
                      key={field?.id ?? column.name}
                      scope="col"
                      data-column={column.name}
                      data-field-id={field?.id}
                      data-field-collapsed={collapsed || undefined}
                      data-title-field={field?.isTitle || undefined}
                      data-system-column={systemColumn(column)}
                      className={classes}
                      style={columnWidthStyle(field, true)}
                      aria-label={label}
                      aria-description={details}
                      onPointerDown={(event) => startDrag(event, index)}
                      onKeyDown={(event) => onHeaderKeyDown(event, index)}
                      onClickCapture={(event) => {
                        if (!suppressClick.current) return;
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      {field && insertControl(field)}
                      <div
                        className={`${styles.headerContents} ${removable ? styles.headerContentsRemovable : ''}`}
                      >
                        {field && onHideField && !collapsed && (
                          <button
                            type="button"
                            className={styles.fieldHide}
                            data-column-control=""
                            data-field-hide=""
                            aria-label={`Hide field ${label}`}
                            aria-description={details}
                            title={
                              lastShown
                                ? 'The last shown field can’t be hidden'
                                : `Hide field ${label}`
                            }
                            aria-busy={pending || undefined}
                            aria-disabled={pending || lastShown || undefined}
                            disabled={controlsDisabled || dragging}
                            onPointerDown={(event) => {
                              setHoveredBoundary(null);
                              event.stopPropagation();
                            }}
                            onClick={() => {
                              if (!controlsDisabled && !pending && !dragging && !lastShown)
                                onHideField(field);
                            }}
                          >
                            <HideIcon />
                          </button>
                        )}
                        {removable && field && (
                          <button
                            type="button"
                            className={styles.fieldRemove}
                            data-column-control=""
                            data-field-remove-trigger=""
                            aria-label={`Remove field ${label}`}
                            title={`Remove field ${label} — click to archive or delete, or drag to the trash to archive`}
                            aria-haspopup="dialog"
                            aria-disabled={removeDisabled || undefined}
                            draggable={!removeDisabled}
                            onPointerDown={(event) => {
                              setHoveredBoundary(null);
                              event.stopPropagation();
                            }}
                            onDragStart={(event) => {
                              if (removeDisabled) {
                                event.preventDefault();
                                return;
                              }
                              setTableFieldDragPayload(event, {
                                tableId: field.tableId,
                                fieldId: field.id,
                                name: field.name,
                              });
                            }}
                            onDragEnd={clearTableFieldDragPayload}
                            onClick={(event) => {
                              if (!removeDisabled) onRemoveField?.(field, event.currentTarget);
                            }}
                          >
                            <TrashIcon />
                          </button>
                        )}
                        {!collapsed &&
                          (field && !field.managed && onEditField ? (
                            <Tooltip label={details} side="bottom">
                              <button
                                type="button"
                                className={styles.fieldButton}
                                data-field-edit-trigger=""
                                aria-label={`Edit field ${label}`}
                                aria-description={details}
                                aria-haspopup="dialog"
                                aria-expanded={editing}
                                aria-controls={editing ? fieldEditorId : undefined}
                                aria-disabled={editDisabled || undefined}
                                aria-keyshortcuts={
                                  reorderable ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined
                                }
                                onClick={(event) => {
                                  if (!editDisabled) onEditField(field, event.currentTarget);
                                }}
                              >
                                {content}
                              </button>
                            </Tooltip>
                          ) : (
                            <Tooltip label={details} side="bottom">
                              {content}
                            </Tooltip>
                          ))}
                        {field && !collapsed && sortControl(field, label)}
                        {field && !collapsed && onFilterChange && isFilterableField(field) && (
                          <TableHeaderFilter
                            field={field}
                            label={label}
                            where={where}
                            onChange={onFilterChange}
                            disabled={dragging || !!resizing}
                          />
                        )}
                      </div>
                      {index === columns.length - 1 && insertControl()}
                      {field && !collapsed && onResizeField && (
                        <span
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Resize ${label} column`}
                          aria-valuemin={TABLE_FIELD_WIDTH_MIN}
                          aria-valuemax={TABLE_FIELD_WIDTH_MAX}
                          aria-valuenow={field.width ?? undefined}
                          aria-valuetext={field.width ? `${field.width} pixels` : 'Auto width'}
                          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+0"
                          aria-disabled={resizeDisabled || undefined}
                          tabIndex={resizeDisabled ? -1 : 0}
                          title={`Resize ${label} — drag; double-click for auto width`}
                          className={styles.columnResize}
                          data-column-control=""
                          data-column-resize=""
                          data-active={resizing === column.name || undefined}
                          onPointerDown={(event) => startResize(event, field, column.name)}
                          onClick={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            if (!resizeDisabled && typeof field.width === 'number')
                              onResizeField(field, null);
                          }}
                          onKeyDown={(event) => onResizeKeyDown(event, field)}
                        />
                      )}
                    </th>
                  );
                })
              )}
            </tr>
          </thead>
          {children && <tbody>{children}</tbody>}
        </table>
      </div>
      {!children && emptyTitle && (
        <div className={styles.emptyBody} role="status">
          <div className={styles.emptyTitle}>{emptyTitle}</div>
          {emptyNote && <p className={styles.emptyNote}>{emptyNote}</p>}
        </div>
      )}
    </div>
  );
};

/** Struck-out eye for a header's hide button. 12×12, currentColor. */
const HideIcon: FC = () => <EyeSlashIcon width={12} height={12} data-hide-icon="" />;

/** Open eye for showing a hidden field again. 12×12, currentColor. */
export const ShowIcon: FC = () => <EyeIcon width={12} height={12} data-show-icon="" />;
