import { type FC } from 'react';

/**
 * Outline container icon used by the Canvas toolbar. Distinct from the
 * solid-fill `BoxIcon` that represents the "container" node kind in the
 * library tree.
 */
export const ContainerIcon: FC = () => (
  <svg
    viewBox="0 0 24 24"
    width={20}
    height={20}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    aria-hidden
    focusable="false"
  >
    <rect x="4" y="6" width="16" height="12" rx="1.5" />
  </svg>
);
