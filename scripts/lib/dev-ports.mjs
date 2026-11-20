/**
 * Fixed dev ports — single source of truth.
 *
 * Dev uses fixed, predictable defaults: the server on DEFAULT_DEV_SERVER_PORT
 * and the client (Vite UI) on DEFAULT_DEV_CLIENT_PORT. Both are overridable per
 * checkout via env so a second worktree runs concurrently with zero port
 * juggling and nothing killed: set PORT (server) and CLIENT_PORT (client) in
 * that checkout's .env.local. Explicit env always wins; if a chosen port is
 * taken the process fails loudly rather than silently moving — the server via its
 * EADDRINUSE handler (apps/server/src/index.ts), Vite via strictPort. No
 * hashing, no auto-derivation.
 *
 * CLIENT_PORT is the single Vite dev-server port, used by both the browser and
 * the Tauri desktop shell — the shell's devUrl points at this port (see
 * apps/desktop/scripts/patch-tauri-port.mjs). The "client" naming matches
 * CLIENT_BASE_URL; there is no separate "desktop app" port in dev.
 *
 * Consumers: apps/server/src/config.ts, apps/desktop-ui/vite.config.ts,
 * apps/desktop/scripts/patch-tauri-port.mjs, playwright.config.ts. Single
 * source — do not copy these numbers anywhere else. Preview uses a separate
 * fixed pair so it can run beside dev. Mirrored in dev-ports.cjs for Jest
 * (keep them in sync).
 */

export const DEFAULT_DEV_SERVER_PORT = 4001;
export const DEFAULT_DEV_CLIENT_PORT = 3001;
export const DEFAULT_PREVIEW_SERVER_PORT = 4101;
export const DEFAULT_PREVIEW_CLIENT_PORT = 3101;
