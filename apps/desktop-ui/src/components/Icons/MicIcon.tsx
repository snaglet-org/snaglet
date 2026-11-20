import { type FC } from 'react';

/**
 * Microphone glyph for the voice chrome (Dictation and Open conversation
 * button). Monochrome line icon — strokes use `currentColor` so the
 * hosting Button's variant color flows through, matching the rest of the
 * outline icon set (CheckIcon, ToolIcon, …).
 */
export const MicIcon: FC = () => (
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
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
    <path d="M8.5 21h7" />
  </svg>
);
