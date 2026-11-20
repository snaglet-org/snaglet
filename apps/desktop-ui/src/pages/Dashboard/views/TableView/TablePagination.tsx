import { useId } from 'react';
import { TABLE_ENTRY_PAGE_SIZES } from '@snaglet/shared/types';
import { Button, Select } from '@desktop/components';
import styles from './TablePagination.module.scss';

export interface TablePaginationProps {
  page: number;
  pageSize: number;
  totalCount: number;
  /** `totalCount` counts search matches: "3 matching", "1–25 of 80 matching". */
  filtered?: boolean;
  disabled?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}

export function TablePagination({
  page,
  pageSize,
  totalCount,
  filtered,
  disabled,
  onPageChange,
  onPageSizeChange,
}: TablePaginationProps) {
  const id = useId();
  const pages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(pages, Math.max(1, page));
  const start = totalCount ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, totalCount);
  const hasPages = pages > 1;
  const count = totalCount.toLocaleString();
  return (
    <div
      className={`${styles.pagination} ${hasPages ? styles.paged : ''}`}
      role="group"
      aria-label="Entry pagination"
    >
      <span
        className={styles.count}
        role="status"
        aria-label={hasPages ? `Page ${currentPage} of ${pages}` : undefined}
      >
        {hasPages
          ? `${start.toLocaleString()}–${end.toLocaleString()} of ${count}${filtered ? ' matching' : ''}`
          : `${count} ${filtered ? 'matching' : totalCount === 1 ? 'row' : 'rows'}`}
      </span>
      {hasPages && filtered && (
        <span className={styles.compactCount} aria-hidden="true">
          {count} matching
        </span>
      )}
      {hasPages && (
        <div className={styles.navigation}>
          <Button
            size="sm"
            variant="ghost"
            className={`${styles.pageButton} ${styles.edgeButton}`}
            disabled={disabled || currentPage <= 1}
            onClick={() => onPageChange(1)}
            aria-label="First page"
          >
            «
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={styles.pageButton}
            disabled={disabled || currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            aria-label="Previous page"
          >
            ‹
          </Button>
          {/* Narrow panes swap the range for this compact position. */}
          <span className={styles.compactPage}>
            <span aria-hidden="true">
              {currentPage.toLocaleString()} / {pages.toLocaleString()}
            </span>
            <span className={styles.srOnly}>
              Page {currentPage} of {pages}
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            className={styles.pageButton}
            disabled={disabled || currentPage >= pages}
            onClick={() => onPageChange(currentPage + 1)}
            aria-label="Next page"
          >
            ›
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={`${styles.pageButton} ${styles.edgeButton}`}
            disabled={disabled || currentPage >= pages}
            onClick={() => onPageChange(pages)}
            aria-label="Last page"
          >
            »
          </Button>
        </div>
      )}
      {onPageSizeChange && totalCount > Math.min(...TABLE_ENTRY_PAGE_SIZES) && (
        <label className={styles.pageSize} htmlFor={id}>
          <span className={styles.srOnly}>Rows per page</span>
          <Select
            unstyled
            className={styles.select}
            id={id}
            value={pageSize}
            disabled={disabled}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {TABLE_ENTRY_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
          <span aria-hidden="true">/ page</span>
        </label>
      )}
    </div>
  );
}
