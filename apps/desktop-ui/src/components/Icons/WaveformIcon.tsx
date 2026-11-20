import { type FC } from 'react';

/**
 * Waveform glyph for the Voice-mode toggle (agent
 * replies spoken aloud, as distinct from the plain MicIcon used for
 * Dictation). Monochrome bars — matches the outline icon set (MicIcon,
 * PaperclipIcon, …); strokes use `currentColor` so the hosting Button's
 * variant color flows through.
 */
export const WaveformIcon: FC = () => (
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
    <path d="M2.5 12h1.5" />
    <path d="M7 8.5v7" />
    <path d="M11 4.5v15" />
    <path d="M15 7v10" />
    <path d="M19 9.5v5" />
    <path d="M21.5 12h.5" />
  </svg>
);
