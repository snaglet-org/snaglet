import { type FC } from 'react';

/**
 * Memory node glyph — a stylized IC / chip. Monochrome line icon
 * (stroke = `currentColor`) replacing the 🧠 emoji in the archived-items
 * list, matching the outline icon set.
 */
export const MemoryIcon: FC = () => (
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
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3" />
  </svg>
);
