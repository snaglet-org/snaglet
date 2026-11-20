import { type FC } from 'react';

/**
 * Plus glyph (add / zoom in; Bootstrap Icons `plus-lg`). Follows the icon
 * family's currentColor convention; same 14×14 footprint as RefreshIcon so
 * they sit evenly in the status bar's icon-only buttons.
 */
export const PlusIcon: FC = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden focusable="false">
    <path
      fillRule="evenodd"
      d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2"
    />
  </svg>
);
