import { useCallback, useMemo, useRef } from 'react';

/** Where a mouse or pointer event happened; any React mouse or pointer event fits. */
export type PointerSpot = { clientX: number; clientY: number };

/**
 * Hover-to-highlight for a keyboard list, without letting a resting pointer
 * take the highlight. When rows appear, change or scroll under a pointer that
 * has not moved, browsers still send mouseover/mouseenter (and WebKit a
 * mousemove) at the same spot, so a list that highlights on hover would move
 * the active row away from the top result the user is about to open with
 * Enter.
 *
 * Call `moved(event)` from the rows' `onMouseMove`: it is true only when the
 * pointer is somewhere else than at the last event. The first event after
 * `reset()` (call it when the list opens or its query changes) only learns
 * where the pointer rests.
 */
export function usePointerMoveGate(): {
  moved: (event: PointerSpot) => boolean;
  reset: () => void;
} {
  const lastSpot = useRef<{ x: number; y: number } | null>(null);
  const moved = useCallback((event: PointerSpot) => {
    const last = lastSpot.current;
    lastSpot.current = { x: event.clientX, y: event.clientY };
    return last !== null && (last.x !== event.clientX || last.y !== event.clientY);
  }, []);
  const reset = useCallback(() => {
    lastSpot.current = null;
  }, []);
  return useMemo(() => ({ moved, reset }), [moved, reset]);
}
