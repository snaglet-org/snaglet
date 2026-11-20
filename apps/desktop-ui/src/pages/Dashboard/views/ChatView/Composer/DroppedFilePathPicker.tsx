// DroppedFilePathPicker — "which file did you mean?" popover shown when
// Spotlight path-recovery (see `../../../../../utils/dropPathRecovery`)
// finds more than one on-disk file matching a dropped file's name/size/
// content-hash. Reuses the same anchored-portal popover building block as
// the editor's SlashMenu/NodeMentionSearch (`EditorPopover`) rather than
// introducing a new dropdown component.
import {
  EditorPopover,
  EditorPopoverHeader,
  editorPopoverStyles as popoverStyles,
  type EditorPopoverAnchor,
} from '@desktop/features/rich-markdown/editor/EditorPopover';

export interface DroppedFilePathPickerProps {
  anchor: EditorPopoverAnchor;
  candidates: string[];
  onPick: (path: string) => void;
  onDismiss: () => void;
}

export function DroppedFilePathPicker({
  anchor,
  candidates,
  onPick,
  onDismiss,
}: DroppedFilePathPickerProps) {
  return (
    <EditorPopover anchor={anchor} ariaLabel="Choose the dropped file's path">
      <EditorPopoverHeader glyph="⌥" text="Multiple files match — choose one" />
      <ul className={popoverStyles.list}>
        {candidates.map((path) => (
          <li key={path}>
            <button
              type="button"
              className={popoverStyles.row}
              role="option"
              aria-selected={false}
              title={path}
              // Mousedown (not click) so the composer never loses focus,
              // matching SlashMenu/NodeMentionSearch's row activation.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(path);
              }}
            >
              <span className={popoverStyles.body}>
                <span className={popoverStyles.label}>{path}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={popoverStyles.row}
        onMouseDown={(e) => {
          e.preventDefault();
          onDismiss();
        }}
      >
        <span className={popoverStyles.body}>
          <span className={popoverStyles.label}>Cancel</span>
        </span>
      </button>
    </EditorPopover>
  );
}
