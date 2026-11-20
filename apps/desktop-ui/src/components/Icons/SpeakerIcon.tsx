import { type FC } from 'react';

/**
 * Speaker glyph — marks the agent currently holding the voice floor in the
 * agent-pills row. Monochrome line icon (stroke = `currentColor`) so it
 * inherits the pill's text color.
 */
export const SpeakerIcon: FC = () => (
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
    <path d="M4 9.5h3l4.5-3.5v12L7 14.5H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6" />
    <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);
