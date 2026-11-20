import { type FC } from 'react';

/**
 * Glyph for a direct-message conversation (the DM pane's tab): two
 * overlapping speech bubbles, one per side. Outline in `currentColor`; 20px
 * by default, smaller in pane chrome.
 */
export const DmsViewIcon: FC<{ size?: number }> = ({ size = 20 }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
  >
    <path d="M3.5 5.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3a2 2 0 0 1-2-2z" />
    <path d="M18 8.5h.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2v3l-3.5-3h-4a2 2 0 0 1-2-2v-.5" />
  </svg>
);
