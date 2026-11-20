import { type FC } from 'react';

/**
 * Minus glyph (remove / zoom out; Bootstrap Icons `dash-lg`). Follows the icon
 * family's currentColor convention; same 14×14 footprint as RefreshIcon so
 * they sit evenly in the status bar's icon-only buttons.
 */
export const MinusIcon: FC = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden focusable="false">
    <path fillRule="evenodd" d="M2 8a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11A.5.5 0 0 1 2 8" />
  </svg>
);
