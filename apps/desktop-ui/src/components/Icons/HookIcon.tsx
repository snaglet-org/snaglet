import { type FC } from 'react';

/**
 * Node icon for an individual lifecycle hook — a lightning bolt. Matches
 * ToolIcon's row-icon conventions (14×14, `currentColor` stroke, viewBox
 * 0 0 24 24).
 */
export const HookIcon: FC = () => (
  <svg
    viewBox="0 0 24 24"
    width={14}
    height={14}
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
  >
    <path d="M13 3 5 13h5l-1 8 8-10h-5l1-8Z" />
  </svg>
);
