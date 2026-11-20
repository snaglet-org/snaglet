/**
 * Whether the UI is running inside a Tauri shell (packaged build or
 * `tauri dev`) rather than a plain browser such as the Vite dev shell.
 *
 * Tauri v2 always exposes `window.__TAURI_INTERNALS__`; `window.__TAURI__`
 * additionally appears when `app.withGlobalTauri` is enabled. Without either,
 * `invoke()` from `@tauri-apps/api/core` throws ("Cannot read properties of
 * undefined (reading 'invoke')") instead of reaching a native command, so
 * callers should check this before invoking.
 *
 * Hoisted from `dropPathRecovery/resolveDroppedFilePath.ts`; the same check
 * also appears inline in `nativeFileDrop/nativeFileDropRegistry.ts`.
 */
export function isTauriEnv(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__);
}
