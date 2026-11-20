import { TablePagination, type TablePaginationProps } from './TablePagination';
import styles from './TablePagerBar.module.scss';

/**
 * The pager as a bar that stays at the bottom of the table pane: « ‹ › » with
 * the range and the page size, pinned (sticky, in the grid's own scroll) so it
 * never scrolls away with the rows. It carries the same pager the toolbar used
 * to, so there is one set of controls.
 */
export function TablePagerBar(props: TablePaginationProps) {
  return (
    <div className={styles.bar} data-table-pager-bar="">
      <TablePagination {...props} />
    </div>
  );
}
