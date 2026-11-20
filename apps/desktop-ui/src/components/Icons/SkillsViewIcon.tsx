import { type FC } from 'react';

/**
 * Activity-bar glyph for the Skills view: an open book with a spark. Follows
 * the icon family's currentColor convention so the activity bar controls
 * active and hover states.
 */
export const SkillsViewIcon: FC = () => (
  <svg
    viewBox="0 0 24 24"
    width={20}
    height={20}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
  >
    <path d="M3 5.5C5.5 4.5 8.5 4.5 12 6.5c3.5-2 6.5-2 9-1v13c-2.5-1-5.5-1-9 1-3.5-2-6.5-2-9-1z" />
    <path d="M12 6.5v13" />
    <path d="M17 1.5v3M15.5 3h3" />
  </svg>
);
