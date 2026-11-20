import { type FC } from 'react';

/**
 * Export glyph: an arrow dropping into a tray. Shared by the workspace-tree
 * row export action and the pane topbar Export button so both read the same.
 * Inherits size from CSS (or the `size` prop) and color from currentColor.
 */
export const ExportIcon: FC<{ size?: number }> = ({ size }) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    aria-hidden
    focusable="false"
  >
    <path d="M8 2v7m0 0 3-3M8 9 5 6M3 11v2h10v-2" />
  </svg>
);
