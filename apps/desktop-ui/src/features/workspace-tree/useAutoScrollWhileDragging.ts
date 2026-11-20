import { useEffect } from 'react';
import { createEdgeAutoScroller } from '@desktop/utils/edgeAutoScroll';

/**
 * Auto-scroll the tree body while a drag is in progress, through the shared
 * edge scroller (also used by table column drags): within 60px of the top or
 * bottom it scrolls faster the closer the cursor is to the edge, until the
 * cursor leaves the zone, the drag ends, or the body unmounts.
 *
 * Takes the element itself, not a ref: the body unmounts while the sidebar
 * shows another view (or the tree is loading or empty) and mounts as a new
 * element, which needs its own listeners.
 */
export function useAutoScrollWhileDragging(el: HTMLElement | null): void {
  useEffect(() => {
    if (!el) return;
    const scroller = createEdgeAutoScroller(el, { axis: 'y' });
    const onDragOver = (e: DragEvent) => scroller.update(e.clientX, e.clientY);
    const stop = () => scroller.stop();

    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', stop);
    el.addEventListener('drop', stop);
    window.addEventListener('dragend', stop);

    return () => {
      stop();
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', stop);
      el.removeEventListener('drop', stop);
      window.removeEventListener('dragend', stop);
    };
  }, [el]);
}
