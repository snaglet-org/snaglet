import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Element } from 'hast';

import { Button } from '@desktop/components';
import { cn } from '@desktop/utils/classNames';
import { WHEEL_SCROLL_X_PROPS } from '@desktop/utils/horizontalWheelScroll';
import { showToast } from '@desktop/utils/toast';
import { MarkdownTableModal } from './MarkdownTableModal';
import {
  isNumericColumn,
  nextSort,
  readTableText,
  rowsLabel,
  sortedRowOrder,
  tableAsHtml,
  tableAsTsv,
  type TableSort,
  type TableText,
} from './markdownTableData';
import { isCellClick, keepDoubleClick } from './tableClick';
import markdownStyles from './MarkdownRenderer.module.scss';
import styles from './MarkdownTable.module.scss';

type Part<P = { children?: ReactNode }> = ReactElement<P>;

/** The element children of a React node; react-markdown can leave strings between them. */
function partsOf<P = { children?: ReactNode }>(children: ReactNode): Part<P>[] {
  return Children.toArray(children).filter((child): child is Part<P> => isValidElement(child));
}

interface TableParts {
  head: Part;
  headRow: Part;
  headerCells: Part<ComponentProps<'th'>>[];
  body: Part | undefined;
  rows: Part[];
}

/**
 * react-markdown's thead / header row / tbody rows, checked cell for cell
 * against the hast text. Null when they disagree anywhere: sorting by text
 * that isn't the row on screen would be a guess, so the table then renders
 * as it came.
 */
function readParts(children: ReactNode, text: TableText): TableParts | null {
  const sections = partsOf(children);
  const head = sections.find((part) => part.type === 'thead');
  const body = sections.find((part) => part.type === 'tbody');
  const headRow = head && partsOf(head.props.children)[0];
  if (!head || !headRow) return null;
  const headerCells = partsOf<ComponentProps<'th'>>(headRow.props.children);
  const rows = body ? partsOf(body.props.children) : [];
  const matches =
    headerCells.length === text.header.length &&
    rows.length === text.rows.length &&
    rows.every((row, index) => partsOf(row.props.children).length === text.rows[index].length);
  return matches ? { head, headRow, headerCells, body, rows } : null;
}

/** A header's own sort button, which `isCellClick` lets through. */
const SORT_BUTTON = '[data-table-sort]';

type BarPlacement = 'above' | 'below' | 'belowInRoom';

/**
 * Whether anything in the rendered markdown sits before (or after) `frame`:
 * a sibling of it or of an ancestor, up to the markdown root.
 */
function hasNeighbor(
  frame: HTMLElement,
  side: 'previousElementSibling' | 'nextElementSibling'
): boolean {
  for (
    let element: HTMLElement | null = frame;
    element && element !== document.body && !element.classList.contains(markdownStyles.markdown);
    element = element.parentElement
  )
    if (element[side]) return true;
  return false;
}

/**
 * Where the hover bar goes: above the table's top-right corner, over what
 * comes before it. A table that opens the markdown has nothing above to host
 * it (and a chat body clips whatever pokes above its top edge), so its bar
 * goes just below the bottom-right corner, over what comes after; never over
 * the table's own headers. A table that is the whole of the markdown keeps
 * the bar's room under itself: below a chat body's bottom edge the bar would
 * be clipped and make the body scroll.
 */
function barPlacement(frame: HTMLElement): BarPlacement {
  if (hasNeighbor(frame, 'previousElementSibling')) return 'above';
  return hasNeighbor(frame, 'nextElementSibling') ? 'below' : 'belowInRoom';
}

/** Rich copy (TSV + HTML) where the clipboard takes it, plain TSV otherwise. */
async function writeTable(header: string[], rows: string[][]): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard) return false;
  const tsv = tableAsTsv(header, rows);
  try {
    if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
      await clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([tsv], { type: 'text/plain' }),
          'text/html': new Blob([tableAsHtml(header, rows)], { type: 'text/html' }),
        }),
      ]);
      return true;
    }
  } catch {
    // A webview can refuse rich items; the plain TSV below still pastes as a table.
  }
  try {
    await clipboard.writeText(tsv);
    return true;
  } catch {
    return false;
  }
}

/**
 * Set by `TableDialog`: the table there renders as its expanded view alone,
 * and this closes it.
 */
export const TableDialogContext = createContext<(() => void) | null>(null);

interface MarkdownTableProps {
  children?: ReactNode;
  /** react-markdown's hast node for the table: the cell text to sort, filter and copy. */
  node?: Element;
}

/**
 * A rendered markdown table (react-markdown's `table` component).
 *
 * The table sits in a frame that scrolls sideways when it is wider than the
 * pane. A click on a header, or its sort button (the arrow, for keyboard and
 * screen-reader users), sorts the rows: ascending, descending, then back to
 * the source order. A hover bar by a corner (see `barPlacement`) shows the
 * row count and offers Copy (TSV + HTML, rows in the order shown) and Expand
 * (MarkdownTableModal, sharing the sort).
 *
 * Everything here is display-only: the markdown never changes. Sorting
 * reorders react-markdown's own row elements by their source index, so a
 * streaming message that adds rows keeps the sort and the new rows join it.
 *
 * Inside a `TableDialog` the table is the expanded view only, with Copy in
 * its toolbar.
 */
export function MarkdownTable({ children, node }: MarkdownTableProps) {
  const closeDialog = useContext(TableDialogContext);
  const [sort, setSort] = useState<TableSort | null>(null);
  const [expanded, setExpanded] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<BarPlacement>('above');
  // Every render: streamed markdown can add a block after the table.
  useLayoutEffect(() => {
    if (frameRef.current) setPlacement(barPlacement(frameRef.current));
  });
  const text = node ? readTableText(node) : null;
  const parts = text && readParts(children, text);

  if (!text || !parts)
    return (
      <div className={styles.frame}>
        <div className={styles.scroll} {...WHEEL_SCROLL_X_PROPS}>
          <table>{children}</table>
        </div>
      </div>
    );

  const numeric = text.header.map((_, column) => isNumericColumn(text.rows, column));
  const activeSort = sort && sort.column < text.header.length ? sort : null;
  const order = sortedRowOrder(text.rows, activeSort, !!activeSort && numeric[activeSort.column]);
  const onSort = (column: number) => setSort((current) => nextSort(current, column));

  // The header text stays plain and selectable; the click lands on the cell.
  // The arrow is a real button, so the header is announced as actionable and
  // sorts from the keyboard (its click bubbles to the cell's handler).
  const headerCell = (cell: Part<ComponentProps<'th'>>, column: number) => {
    const direction = activeSort?.column === column ? activeSort.direction : undefined;
    return cloneElement(
      cell,
      {
        className: cn(cell.props.className, styles.sortable, numeric[column] && styles.numeric),
        'aria-sort': direction,
        onClick: (event: MouseEvent<HTMLElement>) => {
          if (isCellClick(event, SORT_BUTTON)) onSort(column);
        },
        onDoubleClick: keepDoubleClick,
      },
      cell.props.children,
      <button
        type="button"
        className={styles.sortButton}
        data-table-sort=""
        aria-label={`Sort by ${text.header[column] || `column ${column + 1}`}`}
      >
        {direction === 'descending' ? '▼' : '▲'}
      </button>
    );
  };

  const head = cloneElement(
    parts.head,
    undefined,
    cloneElement(parts.headRow, undefined, ...parts.headerCells.map(headerCell))
  );

  // Rows keyed by source index, so React moves them (and an opened cell's
  // state) rather than re-rendering each position with another row's cells.
  const body = (indices: readonly number[]) =>
    parts.body &&
    cloneElement(
      parts.body,
      undefined,
      indices.map((index) => {
        const row = parts.rows[index];
        const cells = partsOf<ComponentProps<'td'>>(row.props.children).map((cell, column) =>
          numeric[column]
            ? cloneElement(cell, { className: cn(cell.props.className, styles.numeric) })
            : cell
        );
        return cloneElement(row, { key: `row-${index}` }, ...cells);
      })
    );

  const copy = async () => {
    const rows = order.map((index) => text.rows[index]);
    const copied = await writeTable(text.header, rows);
    showToast(copied ? `Copied ${rowsLabel(rows.length)}` : "Couldn't copy the table");
  };
  const rowText = text.rows.map((row) => row.join(' ').toLowerCase());

  if (closeDialog)
    return (
      <MarkdownTableModal
        head={head}
        order={order}
        rowText={rowText}
        renderBody={body}
        onClose={closeDialog}
        onCopy={() => void copy()}
      />
    );

  return (
    <div
      ref={frameRef}
      className={cn(
        styles.frame,
        placement !== 'above' && styles.barBelow,
        placement === 'belowInRoom' && styles.barRoom
      )}
    >
      <div className={styles.scroll} {...WHEEL_SCROLL_X_PROPS}>
        <table>
          {head}
          {body(order)}
        </table>
      </div>
      <div className={styles.bar} onDoubleClick={keepDoubleClick}>
        <div className={styles.barInner}>
          <span className={styles.count}>{rowsLabel(text.rows.length)}</span>
          <Button size="sm" aria-label="Copy table" onClick={() => void copy()}>
            Copy
          </Button>
          <Button size="sm" aria-label="Expand table" onClick={() => setExpanded(true)}>
            Expand
          </Button>
        </div>
      </div>
      {expanded && (
        <MarkdownTableModal
          head={head}
          order={order}
          rowText={rowText}
          renderBody={body}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  );
}
