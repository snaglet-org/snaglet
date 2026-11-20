import { useMemo, type FC } from 'react';
import { Chip } from '@desktop/components/Chip';
import { isMacPlatform, shortcutHint } from '@desktop/utils/platform';
import { useStatusBarSlot } from '../StatusBarContext';
import type { StatusBarSlot } from '../types';
import styles from './QuickSearchSlot.module.scss';

/**
 * QuickSearchSlot — a status-bar button that opens the command palette
 * (quick search), with a keycap hint so the user learns the ⌘K / Ctrl+K
 * shortcut. The shortcut itself is bound globally in Dashboard via
 * `useHotkey({ key: 'k', meta: true })`, which fires on both ⌘ (mac) and
 * Ctrl (others), so this button and the hotkey open the same palette.
 *
 * Headless: registers a `custom` slot in the left zone and renders null.
 * Mounted under StatusBarProvider by Dashboard, which passes `onOpen`
 * wired to the palette's open state.
 */

// Evaluated once at module load — the host OS doesn't change. The keycap
// reads "⌘ K" on macOS and "Ctrl K" elsewhere.
const MOD_LABEL = isMacPlatform() ? '⌘' : 'Ctrl';
const SHORTCUT_HINT = shortcutHint('K');

export const QuickSearchSlot: FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const slot = useMemo<StatusBarSlot>(
    () => ({
      id: 'quick-search',
      zone: 'left',
      order: 10,
      item: {
        type: 'custom',
        render: () => (
          <Chip
            size="xs"
            variant="outline"
            tone="muted"
            icon={<span aria-hidden="true">⌕</span>}
            onClick={onOpen}
            title={`Quick search (${SHORTCUT_HINT})`}
          >
            <span className={styles.body}>
              <span className={styles.label}>Quick search</span>
              <kbd className={styles.kbd}>
                {MOD_LABEL}
                <span className={styles.key}>K</span>
              </kbd>
            </span>
          </Chip>
        ),
      },
    }),
    [onOpen]
  );

  useStatusBarSlot(slot);
  return null;
};
