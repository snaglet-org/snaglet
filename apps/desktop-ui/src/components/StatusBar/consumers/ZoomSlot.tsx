import { useMemo, useSyncExternalStore, type FC } from 'react';
import { MinusIcon, PlusIcon } from '@desktop/components/Icons';
import { Tooltip } from '@desktop/components/Tooltip/Tooltip';
import { shortcutHint } from '@desktop/utils/platform';
import { useStatusBarSlot } from '../StatusBarContext';
import type { StatusBarSlot } from '../types';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  getZoom,
  isDesktopShell,
  resetZoom,
  subscribeToZoom,
  zoomIn,
  zoomOut,
} from './zoomWindow';
import styles from './ZoomSlot.module.scss';

/**
 * ZoomSlot — status-bar zoom controls for the packaged Tauri shell:
 * − / percentage / + , where clicking the percentage resets to 100%.
 *
 * Desktop only: the webview has no browser chrome, so these buttons and the
 * `useZoomHotkeys` bindings are the only zoom controls. In a browser, CSS
 * zoom would stack on native zoom, so this renders nothing there.
 *
 * Headless like ReloadSlot: registers a `custom` slot in the right zone just
 * before Reload (order 25 vs 30) and renders null. Hotkeys change zoom
 * outside React, so the percentage reads the shared module through
 * `useSyncExternalStore`.
 */

// "⌘+" on macOS, "Ctrl++" elsewhere, like the other slots' hints.
const HINT_IN = shortcutHint('+');
const HINT_OUT = shortcutHint('−');
const HINT_RESET = shortcutHint('0');

const ZoomSlotContent: FC = () => {
  const zoom = useSyncExternalStore(subscribeToZoom, getZoom);
  const percent = Math.round(zoom * 100);

  const slot = useMemo<StatusBarSlot>(
    () => ({
      id: 'zoom-ui',
      zone: 'right',
      order: 25,
      item: {
        type: 'custom',
        render: () => (
          <span className={styles.group}>
            <Tooltip label={`Zoom out (${HINT_OUT})`} side="top">
              <button
                type="button"
                className={styles.button}
                onClick={zoomOut}
                disabled={zoom <= MIN_ZOOM}
                aria-label="Zoom out"
              >
                <MinusIcon />
              </button>
            </Tooltip>
            <Tooltip label={`Reset zoom (${HINT_RESET})`} side="top">
              <button
                type="button"
                className={styles.percent}
                onClick={resetZoom}
                aria-label="Reset zoom"
              >
                {percent}%
              </button>
            </Tooltip>
            <Tooltip label={`Zoom in (${HINT_IN})`} side="top">
              <button
                type="button"
                className={styles.button}
                onClick={zoomIn}
                disabled={zoom >= MAX_ZOOM}
                aria-label="Zoom in"
              >
                <PlusIcon />
              </button>
            </Tooltip>
          </span>
        ),
      },
    }),
    [zoom, percent]
  );

  useStatusBarSlot(slot);
  return null;
};

/**
 * Outer gate kept as a separate component so the inner one can call hooks
 * unconditionally. `isDesktopShell` is constant for the app's lifetime (the
 * shell injects its marker before any script runs), so the branch never
 * flips mid-session.
 */
export const ZoomSlot: FC = () => (isDesktopShell() ? <ZoomSlotContent /> : null);
