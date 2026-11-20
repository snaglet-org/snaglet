import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  RelatedTableEntries,
  RelatedTableItems,
  TableEntry,
  TableField,
} from '@snaglet/shared/types';
import { Popover, usePopover } from '@desktop/components';
import { CheckIcon, TrashIcon } from '@desktop/components/Icons';
import type { BoardGroup } from './boardGroups';
import { CopyEntryIdButton } from './CopyEntryIdButton';
import { moveMenuFocus } from './menuFocus';
import { SelectOptionTag } from './SelectOptionTag';
import { TableEntryValueView } from './TableEntryValueView';
import { RepeatCellText } from './repeat/RepeatCellText';
import { cellWall } from './repeat/useEntryRepeats';
import { cellRepeatKey, type TableRepeatsMap } from './repeat/useTableRepeats';
import styles from './TableBoard.module.scss';

/** Most fields a card lists under its title. */
export const CARD_FIELD_LIMIT = 4;
/** The Move menu's tallest rendering (matches `.cardMenu` max-height). */
const MENU_MAX_HEIGHT = 320;

interface Props {
  entry: TableEntry;
  /** The card's title, or its "Untitled N" label. */
  label: string;
  nameField: TableField | undefined;
  /** Non-empty fields to list compactly, already capped. */
  fields: readonly TableField[];
  groups: readonly BoardGroup[];
  /** The column the card sits in (its pending move included). */
  currentKey: string;
  relatedEntries?: RelatedTableEntries;
  relatedItems?: RelatedTableItems;
  /** The table's repeating rows: a repeating date reads as its next occurrence. */
  repeats?: TableRepeatsMap;
  /** The card's move is saving; it waits for the server before another. */
  pending: boolean;
  disabled: boolean;
  onOpen: () => void;
  onMove: (toKey: string) => void;
  /** Deletes the entry at once; the table's Undo brings it back. */
  onDelete?: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * One Board card: the entry's title, then up to four other filled-in
 * fields as the grid shows them. The title opens the entry; dragging the
 * card moves it to another column, and the "Move" menu does the same from
 * the keyboard. The copy icon beside it copies the entry's id, and the trash
 * icon deletes the entry (undoable, like a grid delete).
 */
export function TableBoardCard({
  entry,
  label,
  nameField,
  fields,
  groups,
  currentKey,
  relatedEntries,
  relatedItems,
  repeats,
  pending,
  disabled,
  onOpen,
  onMove,
  onDelete,
  onDragStart,
}: Props) {
  const menu = usePopover();
  const titleValue = nameField ? (entry.values[nameField.id] ?? null) : null;
  // The column scroller clips anything positioned inside it, so the menu is
  // fixed to the viewport, under (or above) the trigger, measured on open.
  const [menuPlacement, setMenuPlacement] = useState<CSSProperties>({});
  const triggerRef = menu.triggerRef;
  useLayoutEffect(() => {
    if (!menu.open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const openUp =
      rect.bottom + MENU_MAX_HEIGHT + 8 > window.innerHeight && rect.top > MENU_MAX_HEIGHT;
    setMenuPlacement({
      right: Math.max(8, window.innerWidth - rect.right),
      ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
  }, [menu.open, triggerRef]);
  return (
    <li
      className={styles.card}
      data-board-card={entry.id}
      data-board-pending={pending || undefined}
      aria-busy={pending || undefined}
      onPointerDown={(event) => {
        if (disabled || pending || event.button !== 0) return;
        // Buttons and chips keep their own clicks; the rest of the card drags.
        if (event.target instanceof Element && event.target.closest('button, a, [role="menu"]'))
          return;
        onDragStart(event);
      }}
    >
      <div className={styles.cardHead}>
        <button
          type="button"
          className={styles.cardOpen}
          aria-label={`Open ${label}`}
          disabled={disabled}
          onClick={onOpen}
          onPointerDown={(event) => {
            if (!disabled && !pending && event.button === 0) onDragStart(event);
          }}
        >
          {nameField ? (
            <TableEntryValueView field={nameField} value={titleValue} untitledLabel={label} />
          ) : (
            <span>{label}</span>
          )}
        </button>
        <CopyEntryIdButton entryId={entry.id} className={styles.cardCopy} />
        {onDelete && (
          <button
            type="button"
            className={styles.cardDelete}
            aria-label={`Delete ${label}`}
            title="Delete entry"
            disabled={disabled || pending}
            onClick={(event) => {
              // The card neither opens nor drags from its trash icon.
              event.stopPropagation();
              onDelete();
            }}
          >
            <TrashIcon />
          </button>
        )}
        <div className={styles.cardMenuAnchor}>
          <button
            className={styles.cardMove}
            aria-label={`Move ${label}`}
            title="Move to another column"
            aria-haspopup="menu"
            disabled={disabled || pending}
            {...menu.triggerProps}
          >
            <svg
              viewBox="0 0 24 24"
              width={14}
              height={14}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              focusable="false"
            >
              <path d="M4 12h16M14 6l6 6-6 6" />
            </svg>
          </button>
          <div className={styles.cardMenuFixed} style={menu.open ? menuPlacement : undefined}>
            <Popover
              open={menu.open}
              label={`Move ${label}`}
              placement="floating"
              className={styles.cardMenu}
              {...menu.surfaceProps}
            >
              <div role="menu" aria-label={`Move ${label} to`} onKeyDown={moveMenuFocus}>
                {groups.map((group) => {
                  const checked = group.key === currentKey;
                  return (
                    <button
                      key={group.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      className={styles.cardMenuItem}
                      autoFocus={checked}
                      onClick={() => {
                        menu.close();
                        if (!checked) onMove(group.key);
                      }}
                    >
                      <span className={styles.cardMenuCheck} aria-hidden>
                        {checked && <CheckIcon />}
                      </span>
                      {group.option ? (
                        <SelectOptionTag label={group.label} color={group.option.color} />
                      ) : (
                        <span className={styles.cardMenuLabel}>{group.label}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </Popover>
          </div>
        </div>
      </div>
      {fields.length > 0 && (
        <dl className={styles.cardFields}>
          {fields.map((field) => {
            const value = entry.values[field.id] ?? null;
            const cellRepeat =
              field.recurrence && !field.range
                ? repeats?.get(cellRepeatKey(field.id, entry.id))
                : undefined;
            const repeatText = cellRepeat && cellWall(field, value) === cellRepeat.repeat.current;
            return (
              <div key={field.id} className={styles.cardField}>
                <dt className={styles.cardFieldName}>{field.name}</dt>
                <dd className={styles.cardFieldValue}>
                  {repeatText && cellRepeat ? (
                    <span>
                      <span aria-hidden>↻ </span>
                      <RepeatCellText cellRepeat={cellRepeat} />
                    </span>
                  ) : (
                    <TableEntryValueView
                      field={field}
                      value={value}
                      relatedEntries={relatedEntries}
                      relatedItems={relatedItems}
                    />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </li>
  );
}
