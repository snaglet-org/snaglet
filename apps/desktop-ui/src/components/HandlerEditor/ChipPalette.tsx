import type { FC } from 'react';
import { Chip } from '@desktop/components/Chip';
import { clearActiveEditorChipDrag, startEditorChipDrag } from './editorChip';
import styles from './ChipPalette.module.scss';

export interface EditorChipDescriptor {
  /** Stable React key (and the value handed back to `onInsert`). */
  key: string;
  /** Pill label shown to the user. */
  label: string;
  /** Exact, already-quoted literal inserted on click/drop. */
  insertText: string;
  /** Optional tooltip — defaults to `insertText`. */
  title?: string;
}

export interface ChipPaletteProps {
  /** Small group heading above the row, e.g. "Agents" / "Insert trigger". */
  heading?: string;
  chips: EditorChipDescriptor[];
  onInsert: (chip: EditorChipDescriptor) => void;
  /** Shown instead of the row when `chips` is empty. Omit to render nothing. */
  emptyText?: string;
  'aria-label'?: string;
}

/**
 * ChipPalette — a presentational chip row for editor quick-insert
 * affordances. Callers supply the chips (agent, tool, thread or workspace
 * node ids); fetching those lists and deciding insertion rules stay with the
 * caller, so the component stays generic.
 *
 * Drag writes `EDITOR_CHIP_MIME` (editorChip.ts) — a MIME HandlerEditor
 * recognizes and the pane's split-zone drop machinery does not (see that
 * module's doc comment). Click calls `onInsert` directly; the caller decides
 * what "insert" means.
 */
export const ChipPalette: FC<ChipPaletteProps> = ({
  heading,
  chips,
  onInsert,
  emptyText,
  'aria-label': ariaLabel,
}) => {
  if (chips.length === 0 && !emptyText) return null;

  return (
    <div className={styles.group} role="group" aria-label={ariaLabel ?? heading}>
      {heading && <span className={styles.heading}>{heading}</span>}
      {chips.length === 0 ? (
        <span className={styles.empty}>{emptyText}</span>
      ) : (
        <div className={styles.row}>
          {chips.map((chip) => (
            <span
              key={chip.key}
              draggable
              className={styles.dragWrap}
              onDragStart={(e) =>
                startEditorChipDrag(e, { text: chip.insertText, label: chip.label })
              }
              onDragEnd={clearActiveEditorChipDrag}
            >
              <Chip
                size="xs"
                variant="outline"
                tone="neutral"
                title={chip.title ?? chip.insertText}
                onClick={() => onInsert(chip)}
              >
                {chip.label}
              </Chip>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
