import { type FC } from 'react';

/**
 * Activity-bar glyph for the Agents view: the flower-with-a-face Snaglet draws as an
 * agent's avatar (`FlowerAvatar`), as a monochrome outline. Six petals use the
 * avatar's petal curve (`petal()` in `@snaglet/shared/cursor/describe.ts`), scaled
 * from its radius-50 box onto the 24 grid and cut where they meet the face
 * disc, so the face reads as sitting in front of them. The eyes and smile keep
 * the avatar's proportions. `currentColor` throughout, so the activity bar
 * controls the active and hover states in both themes.
 */
export const AgentsViewIcon: FC = () => (
  <svg
    viewBox="0 0 24 24"
    width={20}
    height={20}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
    data-icon="agents"
  >
    <path
      d="M14.33 7.26C14.55 6.5 14.58 5.7 14.53 5.18C14.53 2.67 13.88 1 12 1
        C10.12 1 9.47 2.67 9.47 5.18C9.42 5.7 9.45 6.5 9.67 7.26
        M17.27 11.65C18.04 11.46 18.75 11.08 19.17 10.78C21.34 9.53 22.47 8.13 21.53 6.5
        C20.58 4.87 18.81 5.14 16.64 6.4C16.17 6.61 15.49 7.04 14.94 7.61
        M14.94 16.39C15.49 16.96 16.17 17.39 16.64 17.6C18.81 18.86 20.58 19.13 21.53 17.5
        C22.47 15.87 21.34 14.47 19.17 13.22C18.75 12.92 18.04 12.54 17.27 12.35
        M9.67 16.74C9.45 17.5 9.42 18.3 9.47 18.82C9.47 21.33 10.12 23 12 23
        C13.88 23 14.53 21.33 14.53 18.82C14.58 18.3 14.55 17.5 14.33 16.74
        M6.73 12.35C5.96 12.54 5.25 12.92 4.83 13.22C2.66 14.47 1.53 15.87 2.47 17.5
        C3.42 19.13 5.19 18.86 7.36 17.6C7.83 17.39 8.51 16.96 9.06 16.39
        M9.06 7.61C8.51 7.04 7.83 6.61 7.36 6.4C5.19 5.14 3.42 4.87 2.47 6.5
        C1.53 8.13 2.66 9.53 4.83 10.78C5.25 11.08 5.96 11.46 6.73 11.65"
    />
    <circle cx="12" cy="12" r="5.28" />
    <circle cx="9.89" cy="11.37" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="14.11" cy="11.37" r="0.9" fill="currentColor" stroke="none" />
    <path d="M10.42 14.22Q12 15.8 13.58 14.22" strokeWidth={1.3} />
  </svg>
);
