import { useState, type ReactNode, type SyntheticEvent } from 'react';

import { Button, Modal, TextInput } from '@desktop/components';
import { CellClampContext } from './ExpandableCell';
import { rowsLabel } from './markdownTableData';
import markdownStyles from './MarkdownRenderer.module.scss';
import styles from './MarkdownTable.module.scss';

interface MarkdownTableModalProps {
  /** The inline table's header row: the sort it changes is the inline table's. */
  head: ReactNode;
  /** Source row indices in the current sort order. */
  order: readonly number[];
  /** Each source row's text, lower-cased, for the filter. */
  rowText: readonly string[];
  /** The body with only these source rows, in this order. */
  renderBody: (rows: readonly number[]) => ReactNode;
  /** Shows Copy in the toolbar, for a table with no inline bar to copy from. */
  onCopy?: () => void;
  onClose: () => void;
}

/**
 * Double-clicks stay in the dialog: a doc's preview behind it switches to
 * edit mode on double-click, which would unmount this view mid-selection.
 */
const keepInDialog = (event: SyntheticEvent) => event.stopPropagation();

/**
 * MarkdownTableModal — a markdown table opened large: a filter over its rows
 * (case-insensitive, any cell), the header pinned while the body scrolls, and
 * every long cell open in full. Sorting is shared with the inline table, so
 * a sort made here is still there when the view closes. Esc, the backdrop and
 * Close dismiss it; nothing here changes the markdown.
 */
export function MarkdownTableModal({
  head,
  order,
  rowText,
  renderBody,
  onCopy,
  onClose,
}: MarkdownTableModalProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = needle ? order.filter((index) => rowText[index]?.includes(needle)) : order;
  const total = rowsLabel(order.length);

  return (
    <Modal onClose={onClose} unstyled className={styles.overlay} aria-label="Expanded table">
      <div className={styles.panel} onDoubleClick={keepInDialog}>
        <header className={styles.toolbar}>
          <div className={styles.filter}>
            <TextInput
              inputSize="sm"
              fullWidth
              autoFocus
              placeholder="Filter rows…"
              aria-label="Filter rows"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <span className={styles.filterCount} role="status">
            {needle ? `${shown.length} of ${total}` : total}
          </span>
          {onCopy && (
            <Button size="sm" aria-label="Copy table" onClick={onCopy}>
              Copy
            </Button>
          )}
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className={`${markdownStyles.markdown} ${styles.expandedBody}`}>
          <CellClampContext.Provider value={false}>
            <table>
              {head}
              {renderBody(shown)}
            </table>
          </CellClampContext.Provider>
        </div>
      </div>
    </Modal>
  );
}
