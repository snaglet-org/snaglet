import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type DragEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { TableField } from '@snaglet/shared/types';
import { rememberItem } from '@desktop/features/table-entries/snagletItemTitles';
import { fixedLayerScale, fixedLayerViewport, toFixedLayer } from '@desktop/utils/cssZoom';
import { acceptDroppedChips, useChipDropTarget, type NodeChipData } from '@desktop/utils/nodeChip';
import { columnWidthStyle } from '../columnResize';
import { chipDropProblem, relatedChipEntryId, type ChipDropResult } from './chipDrop';
import styles from '../TableEntries.module.scss';
import noticeStyles from './EntryCell.module.scss';

interface Props extends ComponentPropsWithoutRef<'td'> {
  field?: TableField;
  active?: boolean;
  blocked?: boolean;
  rejectReason?: string;
  /**
   * The dropped chips, in selection order (one, or several from a multi-row
   * sidebar drag), already narrowed to those the field takes. False or a
   * reason refuses the drop; a reason is shown as given.
   */
  onChipDrop?: (chips: NodeChipData[]) => Promise<ChipDropResult>;
}

/**
 * Own the entire cell's drop area, including empty and read-only cells. The
 * cell takes its field's set column width (none while collapsed).
 */
export function EntryCell({
  field,
  active,
  blocked,
  rejectReason,
  onChipDrop,
  children,
  className,
  style,
  ...rest
}: Props) {
  const widthStyle = columnWidthStyle(field);
  const cellRef = useRef<HTMLTableCellElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const [noticePosition, setNoticePosition] = useState<CSSProperties | null>(null);
  const acceptsChip =
    !blocked &&
    !rejectReason &&
    (field?.type === 'text' || field?.type === 'relation') &&
    !field.managed &&
    !!onChipDrop;
  const reject = (message: string) => setNotice({ message });

  // The notice is portaled to <body>, inside the root zoom: place it in rect
  // px and convert to its own CSS px (see utils/cssZoom).
  useLayoutEffect(() => {
    if (!notice || !cellRef.current || !noticeRef.current) return;
    const cell = cellRef.current.getBoundingClientRect();
    const bubble = noticeRef.current.getBoundingClientRect();
    const scale = fixedLayerScale();
    const viewport = fixedLayerViewport();
    const padding = 8 * scale;
    const gap = 4 * scale;
    const below = cell.bottom + gap;
    const top =
      below + bubble.height <= viewport.height - padding ? below : cell.top - gap - bubble.height;
    setNoticePosition(
      toFixedLayer({
        left: Math.max(padding, Math.min(cell.left, viewport.width - bubble.width - padding)),
        top: Math.max(padding, Math.min(top, viewport.height - bubble.height - padding)),
      })
    );
  }, [notice]);

  useEffect(() => {
    if (!notice) return;
    const dismiss = () => setNotice(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    const grid = cellRef.current?.closest('[data-table-entries-grid]') ?? cellRef.current;
    const timeout = window.setTimeout(dismiss, 3000);
    grid?.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('dragstart', dismiss, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    // The source's dragend follows a rejected drop immediately. Keep that
    // rejection readable until the next interaction or the timeout instead.
    return () => {
      window.clearTimeout(timeout);
      grid?.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('dragstart', dismiss, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [notice]);
  const { dropTargetProps, isDragOver } = useChipDropTarget({
    triggerMode: 'always',
    onAcceptList: (list) => {
      const fits = (chip: NodeChipData) =>
        field?.type !== 'relation' || !!relatedChipEntryId(field, chip);
      const fitting = list.chips.filter(fits);
      if (!acceptsChip || !onChipDrop || fitting.length === 0) {
        reject(
          rejectReason ??
            (blocked
              ? 'Editing is unavailable. Try again when this table is ready.'
              : chipDropProblem(field, list.chips[0]))
        );
        return;
      }
      // A single-value relation holds one link: the first that fits.
      const kept = field?.type === 'relation' && !field.multiple ? fitting.slice(0, 1) : fitting;
      const chips = acceptDroppedChips(list, (chip) => kept.includes(chip));
      setNotice(null);
      // The chip carries the item's title until the page reload names it.
      for (const chip of chips) {
        const title = chip.title ?? chip.name;
        if (field?.type === 'relation' && field.referenceKind && title)
          rememberItem(field.referenceKind, chip.id, { title, archived: false });
      }
      void onChipDrop(chips).then((result) => {
        if (typeof result === 'string') reject(result);
        else if (!result)
          reject('Link not added. The row changed or another edit could not be saved. Try again.');
      });
    },
  });
  // Let nested editors handle caret insertion first, while retaining a
  // fallback for a drop on the cell border or other space outside the editor.
  const nestedTarget = (event: DragEvent<HTMLElement>) =>
    active &&
    field?.type === 'text' &&
    !blocked &&
    event.target instanceof Element &&
    event.target.closest('[data-pane-drop-target="node-chip"]') !== event.currentTarget;
  return (
    <td
      {...rest}
      ref={cellRef}
      {...dropTargetProps}
      onDragOverCapture={(event) => {
        if (nestedTarget(event)) dropTargetProps.onDragLeave(event);
        else dropTargetProps.onDragOverCapture(event);
      }}
      onDragOver={(event) => {
        if (!nestedTarget(event)) dropTargetProps.onDragOver(event);
      }}
      onDropCapture={(event) => {
        if (nestedTarget(event)) dropTargetProps.onDragLeave(event);
        else dropTargetProps.onDropCapture(event);
      }}
      onDrop={(event) => {
        if (event.defaultPrevented) event.stopPropagation();
        else dropTargetProps.onDrop(event);
      }}
      className={[className, isDragOver && (acceptsChip ? styles.dropReady : styles.dropRejected)]
        .filter(Boolean)
        .join(' ')}
      style={widthStyle ? { ...widthStyle, ...style } : style}
    >
      {children}
      {notice &&
        createPortal(
          <p
            ref={noticeRef}
            className={noticeStyles.notice}
            role="alert"
            style={noticePosition ?? { opacity: 0 }}
          >
            {notice.message}
          </p>,
          document.body
        )}
    </td>
  );
}
