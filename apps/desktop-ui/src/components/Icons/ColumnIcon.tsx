import { type FC } from 'react';

/**
 * A single table column: a frame split into three columns (Bootstrap Icons
 * `layout-three-columns`). Sized like `TableIcon` so the two sit as siblings
 * in a list (an archived column under its table in the Archived drawer).
 */
export const ColumnIcon: FC = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden focusable="false">
    <path d="M0 1.5A1.5 1.5 0 0 1 1.5 0h13A1.5 1.5 0 0 1 16 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 14.5zM1.5 1a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5H5V1zM10 15V1H6v14zm1 0h3.5a.5.5 0 0 0 .5-.5v-13a.5.5 0 0 0-.5-.5H11z" />
  </svg>
);
