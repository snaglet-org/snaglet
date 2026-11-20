import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// src/config.ts requires these at module load; in dev they come from
// vite.config.ts defines, which this standalone test config skips on purpose.
vi.stubEnv('VITE_API_BASE_URL', '/api');
vi.stubEnv('VITE_APP_NAME', 'Snaglet');

// jsdom has no layout engine, so it omits `document.elementFromPoint`. TipTap's
// placeholder extension calls it on mount (getViewportBoundaryPositions), so any
// test that renders an editor needs it. Provide it once here instead of in each
// test that mounts an editor.
if (!document.elementFromPoint) {
  document.elementFromPoint = () => null;
}

// Explicit cleanup: with vitest globals off, testing-library can't hook a
// global afterEach itself.
afterEach(() => {
  cleanup();
});
