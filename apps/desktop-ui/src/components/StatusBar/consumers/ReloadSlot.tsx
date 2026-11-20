import { useMemo, type FC } from 'react';
import { RefreshIcon } from '@desktop/components/Icons';
import { Tooltip } from '@desktop/components/Tooltip/Tooltip';
import { shortcutHint } from '@desktop/utils/platform';
import { useStatusBarSlot } from '../StatusBarContext';
import type { StatusBarSlot } from '../types';
import { reloadWindow } from './reloadWindow';
import styles from './ReloadSlot.module.scss';

/**
 * ReloadSlot — an icon-only status-bar button that reloads the webview.
 *
 * The packaged Tauri shell has no browser chrome, so this button (plus the
 * ⌘R / Ctrl+R hotkey bound in Dashboard via `useReloadHotkey`) is the only
 * way to refresh the UI. Both paths call the shared `reloadWindow` action.
 * The tooltip carries the shortcut hint, mirroring how QuickSearchSlot
 * advertises ⌘K.
 *
 * Headless: registers a `custom` slot at the far end of the RIGHT zone
 * (after notifications and workers — a chrome-level utility belongs in the
 * bar's corner) and renders null. Mounted under StatusBarProvider by
 * Dashboard.
 */

/** "⌘R" on macOS, "Ctrl+R" elsewhere. Evaluated once at module load. */
const SHORTCUT_HINT = shortcutHint('R');

export const ReloadSlot: FC = () => {
  const slot = useMemo<StatusBarSlot>(
    () => ({
      id: 'reload-ui',
      zone: 'right',
      order: 30,
      item: {
        type: 'custom',
        render: () => (
          <Tooltip label={`Reload UI (${SHORTCUT_HINT})`} side="top">
            <button
              type="button"
              className={styles.button}
              onClick={reloadWindow}
              aria-label="Reload UI"
            >
              <RefreshIcon />
            </button>
          </Tooltip>
        ),
      },
    }),
    []
  );

  useStatusBarSlot(slot);
  return null;
};
