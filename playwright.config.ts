import { defineConfig, devices } from '@playwright/test';
import { config as loadDotenv } from 'dotenv';
import { expand as expandDotenv } from 'dotenv-expand';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEFAULT_DEV_CLIENT_PORT } from './scripts/lib/dev-ports.mjs';

// Local-only suites, not wired into CI. One project per run:
// - `ui` (default, `pnpm test:e2e:ui`) attaches to an externally started dev
//   server (`pnpm dev:desktop-ui`); `webServer` is undefined by design.
// - `built` (SNAGLET_E2E_BUILT=1, `pnpm test:e2e:built`) builds the browser-preview
//   artifact and boots it on its own port against a throwaway home and
//   PostgreSQL cluster (tests/e2e/helpers/builtWorkspace.ts). It never reads
//   this checkout's .env.
const built = process.env.SNAGLET_E2E_BUILT === '1';
// SNAGLET_E2E_ISOLATED=1 points the ui suite at an isolated stack: .env is not read
// and CLIENT_PORT (UI) and PORT (API) must be set, so a missing port can never
// fall back to a running instance.
const isolated = process.env.SNAGLET_E2E_ISOLATED === '1';

// The ui suite otherwise loads this worktree's root .env so CLIENT_PORT (the
// Vite UI port) and PORT (the API port the helpers call) come from a single
// source of truth — a worktree may pin its own. override: true defends against
// a stale port leaked from a parent shell (e.g. the main repo's environment).
// Falls back to the fixed default when unset.
const __dirname = dirname(fileURLToPath(import.meta.url));
if (!built && !isolated) {
  expandDotenv(loadDotenv({ path: resolve(__dirname, '.env'), override: true }));
}
if (isolated && (!process.env.CLIENT_PORT || !process.env.PORT)) {
  throw new Error('SNAGLET_E2E_ISOLATED=1 requires CLIENT_PORT and PORT for the isolated stack.');
}

const clientPort = process.env.CLIENT_PORT ?? String(DEFAULT_DEV_CLIENT_PORT);
const headedBuilt = process.env.SNAGLET_E2E_HEADED === 'true';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: built
    ? [
        {
          name: 'built',
          testMatch: ['built/**/*.spec.ts'],
          use: { ...devices['Desktop Chrome'], headless: !headedBuilt },
        },
      ]
    : [
        {
          name: 'ui',
          testIgnore: ['built/**'],
          use: {
            ...devices['Desktop Chrome'],
            baseURL: `http://localhost:${clientPort}`,
            headless: false,
          },
        },
      ],
  webServer: undefined,
});
