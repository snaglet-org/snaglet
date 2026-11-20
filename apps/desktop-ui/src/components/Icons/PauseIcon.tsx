import { type FC } from 'react';

/** Two vertical bars (pause), in the icon family's currentColor stroke. */
export const PauseIcon: FC = () => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    aria-hidden
    focusable="false"
  >
    <line x1="8" y1="5" x2="8" y2="19" />
    <line x1="16" y1="5" x2="16" y2="19" />
  </svg>
);
