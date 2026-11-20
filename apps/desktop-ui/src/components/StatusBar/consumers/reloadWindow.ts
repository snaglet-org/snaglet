/**
 * reloadWindow — reload the webview via `window.location.reload()`.
 *
 * The packaged Tauri shell has no browser chrome (no toolbar, no native
 * ⌘R), so this is the app's only refresh path; in dev/browser it behaves
 * like a normal page reload. A plain reload is deliberately unguarded:
 * doc autosave and all server state live outside the webview, so nothing
 * is lost.
 *
 * Kept in its own module so the two entry points — the status-bar
 * ReloadSlot button and the Dashboard ⌘R hotkey — share one action, and
 * so tests can mock it: jsdom's `location.reload` is non-configurable and
 * cannot be spied on directly.
 */
export function reloadWindow(): void {
  window.location.reload();
}
