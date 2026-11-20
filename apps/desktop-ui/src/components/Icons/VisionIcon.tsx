import { type FC } from 'react';

/** Framed aperture: vision capture without conflating screen and camera modes. */
export const VisionIcon: FC = () => (
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
    <path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4" />
    <circle cx="12" cy="12" r="4.25" />
    <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
  </svg>
);
