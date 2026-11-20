import { useSyncExternalStore, type FC } from 'react';
import { cn } from '@desktop/utils/classNames';
import { useStatusBarStore } from './StatusBarContext';
import { StatusBarSlotView } from './items';
import type { StatusBarZone } from './types';
import styles from './StatusBar.module.scss';

const ZONES: readonly StatusBarZone[] = ['left', 'center', 'right'];

const zoneClass: Record<StatusBarZone, string> = {
  left: styles.left,
  center: styles.center,
  right: styles.right,
};

/**
 * StatusBar — the thin bar anchored below all panes. Renders whatever slots
 * consumers have registered, grouped into the three zones. The bar itself has
 * no hardcoded content; everything comes from the registry.
 *
 * Mounted once at the Dashboard shell root (grid row 2), inside a
 * <StatusBarProvider>.
 */
export const StatusBar: FC = () => {
  const store = useStatusBarStore();
  const slots = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return (
    <footer className={styles.bar} aria-label="Status bar">
      {ZONES.map((zone) => (
        <div key={zone} className={cn(styles.zone, zoneClass[zone])} data-zone={zone}>
          {slots
            .filter((slot) => slot.zone === zone)
            .map((slot) => (
              <StatusBarSlotView key={slot.id} slot={slot} />
            ))}
        </div>
      ))}
    </footer>
  );
};
