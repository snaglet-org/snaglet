import { useEffect, useRef, useState, type FC } from 'react';
import { Button } from '@desktop/components';
import {
  MOVE_CONFIRMATION_EVENT_NAME,
  type MoveConfirmationDetail,
} from '@desktop/utils/moveConfirmation';
import styles from './MoveConfirmationBanner.module.scss';

/**
 * Dashboard-level banner that surfaces a brief "moved X into Y" message
 * when the workspace tree commits a drop into a collapsed destination
 * (i.e. the user can't visually verify the move). Listens to the global
 * `snaglet:move-confirmation` event bus, renders at most one banner at a
 * time (a new event replaces the previous), and auto-dismisses after
 * ~3.5 seconds. Esc closes it manually.
 */
export const MoveConfirmationBanner: FC = () => {
  const [banner, setBanner] = useState<MoveConfirmationDetail | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<MoveConfirmationDetail>).detail;
      if (!detail) return;
      setBanner(detail);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        setBanner(null);
        timeoutRef.current = null;
      }, detail.durationMs ?? 3500);
    };
    window.addEventListener(MOVE_CONFIRMATION_EVENT_NAME, handler);
    return () => {
      window.removeEventListener(MOVE_CONFIRMATION_EVENT_NAME, handler);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!banner) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBanner(null);
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [banner]);

  if (!banner) return null;

  const arrowDetail = banner.destinationDetail ? (
    <>
      <span className={styles.arrow} aria-hidden>
        →
      </span>
      <span className={styles.detail}>{banner.destinationDetail}</span>
    </>
  ) : null;

  return (
    <div className={styles.bar} role="status" aria-live="polite">
      <span className={styles.tag}>Moved</span>
      <span className={styles.source} title={banner.sourceLabel}>
        {banner.sourceLabel}
      </span>
      <span className={styles.into}>into</span>
      <span className={styles.destination} title={banner.destinationLabel}>
        {banner.destinationLabel}
      </span>
      {arrowDetail}
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        className={styles.dismiss}
        onClick={() => {
          setBanner(null);
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
        }}
        aria-label="Dismiss move confirmation"
      >
        ×
      </Button>
    </div>
  );
};
