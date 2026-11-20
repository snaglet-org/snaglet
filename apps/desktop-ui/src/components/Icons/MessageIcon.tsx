import { type FC } from 'react';

/**
 * Message node glyph — an envelope. Monochrome line icon (stroke =
 * `currentColor`) replacing the ✉️ emoji in the archived-items list,
 * matching the outline icon set.
 */
export const MessageIcon: FC = () => (
  <svg
    viewBox="0 0 24 24"
    width={14}
    height={14}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
  >
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3.5 6.5l8.5 6 8.5-6" />
  </svg>
);
