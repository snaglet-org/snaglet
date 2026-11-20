import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import {
  TOAST_DISMISS_EVENT_NAME,
  TOAST_EVENT_NAME,
  type ToastAction,
  type ToastDetail,
} from '@desktop/utils/toast';
import styles from './ToastHost.module.scss';

interface ActiveToast {
  id: number;
  /** The caller's id (`showToast(…, { id })`), for `dismissToast`. */
  key?: string;
  message: string;
  durationMs: number;
  action?: ToastAction;
}

/**
 * Global toast queue. Listens for `snaglet:toast` custom events from any caller
 * (see `utils/toast.ts`) and renders a stack of dismissable pills at the
 * bottom-right of the viewport. Each entry auto-dismisses after the event's
 * `durationMs`.
 *
 * Every toast's timer pauses while the pointer is over it or focus is inside
 * it, and restarts (full duration) on leave/blur — so an Undo button never
 * vanishes under the cursor. The action button is a normal Tab stop; Escape
 * dismisses the focused toast; an action runs at most once and closes it.
 */
export const ToastHost: FC = () => {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const start = useCallback(
    (id: number, durationMs: number) => {
      const previous = timers.current.get(id);
      if (previous !== undefined) window.clearTimeout(previous);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), durationMs)
      );
    },
    [dismiss]
  );

  const pause = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ToastDetail>).detail;
      if (!detail || !detail.message) return;
      const id = Date.now() + Math.random();
      setToasts((prev) => [
        ...prev,
        {
          id,
          key: detail.id,
          message: detail.message,
          durationMs: detail.durationMs,
          action: detail.action,
        },
      ]);
      start(id, detail.durationMs);
    };
    window.addEventListener(TOAST_EVENT_NAME, handler);
    return () => window.removeEventListener(TOAST_EVENT_NAME, handler);
  }, [start]);

  useEffect(() => {
    const handler = (event: Event) => {
      const key = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (!key) return;
      setToasts((prev) => {
        for (const t of prev) {
          if (t.key !== key) continue;
          const timer = timers.current.get(t.id);
          if (timer !== undefined) window.clearTimeout(timer);
          timers.current.delete(t.id);
        }
        return prev.filter((t) => t.key !== key);
      });
    };
    window.addEventListener(TOAST_DISMISS_EVENT_NAME, handler);
    return () => window.removeEventListener(TOAST_DISMISS_EVENT_NAME, handler);
  }, []);

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) window.clearTimeout(timer);
      active.clear();
    };
  }, []);

  if (typeof document === 'undefined' || toasts.length === 0) return null;

  return createPortal(
    <div className={styles.host} role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem
          key={t.id}
          toast={t}
          onPause={() => pause(t.id)}
          onResume={() => start(t.id, t.durationMs)}
          onDismiss={() => dismiss(t.id)}
        />
      ))}
    </div>,
    document.body
  );
};

interface ToastItemProps {
  toast: ActiveToast;
  onPause: () => void;
  onResume: () => void;
  onDismiss: () => void;
}

const ToastItem: FC<ToastItemProps> = ({ toast, onPause, onResume, onDismiss }) => {
  const ref = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const ran = useRef(false);

  const settle = () => {
    if (hovered.current || focused.current) onPause();
    else onResume();
  };

  return (
    <div
      ref={ref}
      className={styles.toast}
      data-has-action={toast.action ? '' : undefined}
      onPointerEnter={() => {
        hovered.current = true;
        settle();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        settle();
      }}
      onFocus={() => {
        focused.current = true;
        settle();
      }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && ref.current?.contains(event.relatedTarget)) {
          return;
        }
        focused.current = false;
        settle();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }}
    >
      <span className={styles.message}>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            if (ran.current) return;
            ran.current = true;
            onDismiss();
            toast.action?.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
};
