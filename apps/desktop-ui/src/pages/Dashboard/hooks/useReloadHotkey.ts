import { reloadWindow } from '@desktop/components/StatusBar/consumers/reloadWindow';
import { useHotkey } from './useHotkey';

/**
 * useReloadHotkey — bind ⌘R / Ctrl+R to a full webview reload.
 *
 * The packaged Tauri shell has no browser chrome, so without this binding
 * there is no way to refresh the UI at all. Called from Dashboard next to
 * the other global shortcuts (⌘K / ⌘B) through the same `useHotkey`
 * mechanism; the status-bar ReloadSlot button advertises the same action.
 *
 * Like ⌘K — and like the native browser shortcut it stands in for — it
 * fires everywhere, including while focus sits in an input or editor (no
 * `ignoreInEditable`): reload is not a text-editing combo, and a browser's
 * own ⌘R reloads regardless of focus.
 */
export function useReloadHotkey(): void {
  useHotkey({ key: 'r', meta: true }, reloadWindow);
}
