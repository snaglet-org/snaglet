import { type FC } from 'react';

/**
 * Activity-bar glyph for the MCP view: the letters "MCP" drawn as rounded,
 * bold strokes (round caps and joins) on the shared 24 grid, so it matches the
 * other rail icons' size and weight instead of being tiny live text.
 */
export const McpViewIcon: FC = () => (
  <svg
    viewBox="0 0 24 24"
    width={20}
    height={20}
    fill="none"
    stroke="currentColor"
    strokeWidth={2.3}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
  >
    {/* M */}
    <path d="M1.7 17.2V6.8L4.55 12.3L7.4 6.8V17.2" />
    {/* C */}
    <path d="M14.55 8.1A3.05 5.15 0 1 0 14.55 15.9" />
    {/* P */}
    <path d="M17 17.2V6.8H19.35A2.9 2.9 0 0 1 19.35 12.6H17" />
  </svg>
);
