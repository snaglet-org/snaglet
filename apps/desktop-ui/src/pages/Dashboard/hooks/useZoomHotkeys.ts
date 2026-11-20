import { useEffect } from 'react';
import {
  applyPersistedZoom,
  isDesktopShell,
  resetZoom,
  zoomIn,
  zoomOut,
} from '@desktop/components/StatusBar/consumers/zoomWindow';
import { useHotkey } from './useHotkey';

/**
 * Binds the zoom shortcuts in the desktop shell (⌘/Ctrl+= or + zooms in,
 * ⌘/Ctrl+− out, ⌘/Ctrl+0 resets to 100%) and re-applies the persisted level
 * on mount. The Tauri webview has no native zoom, so these stand in for it.
 * In a browser the matchers are registered with `enabled: false`, because
 * useHotkey preventDefaults on match and would suppress native zoom.
 *
 * '=' is the unshifted plus key (US), '+' with shift an explicit ⌘+, and '+'
 * without shift covers layouts where + is unshifted (German) and the numpad.
 * The combos fire in inputs too and keep stepping while held.
 */
export function useZoomHotkeys(): void {
  const enabled = isDesktopShell();

  useHotkey({ key: '=', meta: true, enabled, allowRepeat: true }, zoomIn);
  useHotkey({ key: '+', meta: true, shift: true, enabled, allowRepeat: true }, zoomIn);
  useHotkey({ key: '+', meta: true, enabled, allowRepeat: true }, zoomIn);
  useHotkey({ key: '-', meta: true, enabled, allowRepeat: true }, zoomOut);
  useHotkey({ key: '0', meta: true, enabled, allowRepeat: true }, resetZoom);

  useEffect(() => {
    if (enabled) applyPersistedZoom();
  }, [enabled]);
}
