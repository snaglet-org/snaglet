import type { SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

import { MarkdownRenderer } from './MarkdownRenderer';
import { TableDialogContext } from './MarkdownTable';
import styles from './MarkdownTable.module.scss';

interface TableDialogProps {
  /** One markdown table, as its source reads. */
  markdown: string;
  onClose: () => void;
}

/**
 * Ends an event's React bubbling here, at the dialog's edge, so the host it
 * was opened from (a message composer's paste and file drop, an editor's
 * keys) never handles what happens inside the dialog. The DOM event goes on
 * to the document and window as before: Escape, dismissal and the page-wide
 * drop guards still see it.
 */
const keepInDialog = (event: SyntheticEvent) => {
  event.isPropagationStopped = () => true;
};

const BOUNDARY = {
  onKeyDown: keepInDialog,
  onKeyUp: keepInDialog,
  onPaste: keepInDialog,
  onCopy: keepInDialog,
  onCut: keepInDialog,
  onDragEnter: keepInDialog,
  onDragOver: keepInDialog,
  onDragLeave: keepInDialog,
  onDrop: keepInDialog,
  onMouseDown: keepInDialog,
  onContextMenu: keepInDialog,
};

/**
 * A markdown table opened large on its own, for surfaces that hold no
 * rendered table (a doc's editor): the same expanded view a message table
 * opens, with its filter, sort and Copy. The markdown renders as in a
 * message, so chips, links and inline formatting look the same, and its
 * table shows as the dialog only (`TableDialogContext`). The rendered
 * markdown's own box is empty and hidden, kept out of the host's layout.
 */
export function TableDialog({ markdown, onClose }: TableDialogProps) {
  return createPortal(
    <TableDialogContext.Provider value={onClose}>
      <div className={styles.dialogSource} {...BOUNDARY}>
        <MarkdownRenderer content={markdown} />
      </div>
    </TableDialogContext.Provider>,
    document.body
  );
}
