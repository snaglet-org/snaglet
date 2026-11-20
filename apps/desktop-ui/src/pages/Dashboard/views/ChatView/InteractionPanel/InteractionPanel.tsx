import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { getEffectiveZoom } from '@desktop/utils/cssZoom';
import styles from './InteractionPanel.module.scss';

interface InteractionPanelProps {
  title: string;
  detail?: ReactNode;
  resizeLabel: string;
  children: ReactNode;
  footer: ReactNode;
}

/**
 * Shared shell for blocking chat interactions such as agent questions and tool
 * confirmations. Owns the chrome, scroll region, footer, and drag-to-resize
 * behavior so each interaction implements only its typed content and actions.
 */
export function InteractionPanel({
  title,
  detail,
  resizeLabel,
  children,
  footer,
}: InteractionPanelProps): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  // Ends the drag in progress. A panel can close mid-drag (the request is
  // answered elsewhere or times out), and the drag must not outlive it.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    endDragRef.current?.();
    const startY = event.clientY;
    const startHeight = cardRef.current?.offsetHeight ?? 0;
    const chat = cardRef.current?.parentElement;
    const maxHeight = (chat?.clientHeight ?? window.innerHeight) * 0.5;
    // offsetHeight / clientHeight are the card's own (pane-zoomed) px;
    // pointer deltas are viewport px — convert so the edge tracks the cursor.
    const zoom = getEffectiveZoom(cardRef.current);
    const clamp = (value: number): number => Math.min(maxHeight, Math.max(120, value));
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (moveEvent: PointerEvent): void =>
      setHeight(clamp(startHeight + (startY - moveEvent.clientY) / zoom));
    // A canceled pointer never sends pointerup; without this the page kept
    // `user-select: none` and the move listener until the next click.
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = previousUserSelect;
      endDragRef.current = null;
    };
    endDragRef.current = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <section
      ref={cardRef}
      className={styles.card}
      style={height != null ? { height: `${height}px` } : undefined}
    >
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-orientation="horizontal"
        aria-label={resizeLabel}
        onPointerDown={onResizeStart}
      />
      <header className={styles.header}>
        <span className={styles.title}>{title}</span>
        {detail != null ? <span className={styles.detail}>{detail}</span> : null}
      </header>
      <div className={styles.body}>{children}</div>
      <footer className={styles.footer}>{footer}</footer>
    </section>
  );
}
