import { type FC } from 'react';

/** Right-pointing triangle (play / resume), in the icon family's currentColor stroke. */
export const PlayIcon: FC = () => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
  >
    <path d="M7 4.5v15l12-7.5-12-7.5z" />
  </svg>
);
