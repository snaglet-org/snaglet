import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Button } from '@desktop/components/controls/Button/Button';
import { MinusIcon, PlusIcon } from '@desktop/components/Icons';
import { Tooltip } from '@desktop/components/Tooltip/Tooltip';
import { cn } from '@desktop/utils/classNames';
import { elementPxScale, toElementPx } from '@desktop/utils/cssZoom';
import {
  MAX_SCALE,
  canPan,
  detailScale,
  fitScale,
  fittedView,
  isAtFit,
  panView,
  recenterView,
  stepScale,
  wheelDeltaPx,
  wheelZoomFactor,
  zoomAround,
  type ImageView,
  type Point,
  type Size,
} from './imageViewerMath';
import styles from './ImageViewer.module.scss';

export interface ZoomableImageProps {
  src: string;
  alt: string;
  /** The viewer box. The host sizes it; the image never resizes it. */
  className?: string;
  /** Extra styling for the image itself (edge ring, shadow, backdrop). */
  imageClassName?: string;
  /** Room left around the image when it is fitted, in CSS px. */
  fitPadding?: number;
  /**
   * A click on the empty area around the fitted image — a lightbox closing
   * the way its dimmed backdrop does. Ignored while zoomed and after a drag.
   */
  onBackdropClick?: () => void;
  /** Take keyboard focus on mount, unless focus is already outside this dialog. */
  autoFocus?: boolean;
  /**
   * The largest scale fitting may reach. Actual size (1) by default, so a
   * raster image is never blown up past its pixels; a vector image can fit
   * larger.
   */
  maxFitScale?: number;
  /** Host data attributes for the image element (e.g. a drop-guard marker). */
  imageDataAttributes?: Record<`data-${string}`, string>;
  /**
   * Content laid over the image once it is shown. The layer is the image's
   * natural size, placed and scaled with it, so the content positions itself
   * in natural image pixels and zooms with the picture. The layer ignores
   * the pointer; content that should be clickable re-enables it.
   */
  overlay?: (layout: ImageOverlayLayout) => ReactNode;
}

interface ImageOverlayLayout {
  natural: Size;
  view: ImageView;
}

/** WebKit's trackpad pinch (Safari / WKWebView); Chromium sends Ctrl+wheel instead. */
interface WebKitGestureEvent extends Event {
  scale: number;
  clientX?: number;
  clientY?: number;
}

interface Geometry {
  natural: Size;
  box: Size;
  view: ImageView;
  fit: number;
}

interface Press {
  pointerId: number;
  clientX: number;
  clientY: number;
  moved: boolean;
  /** The view the drag started from; null when the press can't pan. */
  from: ImageView | null;
}

/** Pointer travel (rect px) after which a press is a drag, not a click. */
const CLICK_SLOP = 4;

/** Arrow-key pan, as a share of the box. */
const KEY_PAN_SHARE = 0.1;

const KEY_PAN: Record<string, [number, number]> = {
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

function isPositive(size: Size | null): size is Size {
  return !!size && size.width > 0 && size.height > 0;
}

const center = (g: Geometry): Point => ({ x: g.box.width / 2, y: g.box.height / 2 });

const inToolbar = (target: EventTarget | null) =>
  target instanceof Element && target.closest('[data-image-viewer-toolbar]') !== null;

/**
 * React events bubble through portals: a dialog that overlay content opens
 * (a chip's preview) reaches the viewer's handlers without being inside it.
 */
const fromOutside = (event: { currentTarget: Element; target: EventTarget }) =>
  !(event.target instanceof Node) || !event.currentTarget.contains(event.target);

/**
 * ZoomableImage — one image in a fixed box that can be zoomed (pinch,
 * Ctrl/⌘+wheel, the corner toolbar, + − 0 1 keys, double-click) and panned
 * once it overflows (drag, wheel, arrow keys). It opens at fit and resets to
 * fit when `src` changes.
 *
 * The image is placed with explicit size + translate inside a clipped box, so
 * nothing outside the box moves: no frame resize, no app zoom. ⌘/Ctrl key
 * combos are never handled here — ⌘+/⌘−/⌘0 stay the app's UI zoom
 * (useZoomHotkeys) — and Ctrl/⌘+wheel is preventDefault-ed so the webview's
 * page zoom never fires over the image.
 */
export const ZoomableImage: FC<ZoomableImageProps> = ({
  src,
  alt,
  className,
  imageClassName,
  fitPadding = 0,
  onBackdropClick,
  autoFocus = false,
  maxFitScale = 1,
  imageDataAttributes,
  overlay,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const hintId = useId();

  // Refs are the source of truth so back-to-back wheel / pointer events never
  // read a view React has not rendered yet; state only drives the render.
  const naturalRef = useRef<Size | null>(null);
  const boxRef = useRef<Size | null>(null);
  const viewRef = useRef<ImageView | null>(null);
  const paddingRef = useRef(fitPadding);
  paddingRef.current = fitPadding;
  const maxFitRef = useRef(maxFitScale);
  maxFitRef.current = maxFitScale;
  const pressRef = useRef<Press | null>(null);
  const pinchRef = useRef<{ from: ImageView; anchor: Point } | null>(null);
  const suppressClickRef = useRef(false);

  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size | null>(null);
  const [view, setViewState] = useState<ImageView | null>(null);
  const [animate, setAnimate] = useState(false);
  const [dragging, setDragging] = useState(false);

  const applyView = useCallback((next: ImageView | null, animated = false) => {
    viewRef.current = next;
    setViewState(next);
    setAnimate(animated);
  }, []);

  const geometry = useCallback((): Geometry | null => {
    const naturalSize = naturalRef.current;
    const boxSize = boxRef.current;
    const current = viewRef.current;
    if (!naturalSize || !isPositive(boxSize) || !current) return null;
    return {
      natural: naturalSize,
      box: boxSize,
      view: current,
      fit: fitScale(naturalSize, boxSize, paddingRef.current, maxFitRef.current),
    };
  }, []);

  /** Fit the image to a (new) box — or, if zoomed, keep the zoom across the resize. */
  const reconcile = useCallback(
    (previousBox: Size | null) => {
      const naturalSize = naturalRef.current;
      const boxSize = boxRef.current;
      if (!naturalSize || !isPositive(boxSize)) return;
      const padding = paddingRef.current;
      const maxFit = maxFitRef.current;
      const current = viewRef.current;
      const fitted = fittedView(naturalSize, boxSize, padding, maxFit);
      if (!current || !isPositive(previousBox)) return applyView(fitted);
      const wasFitted = isAtFit(current.scale, fitScale(naturalSize, previousBox, padding, maxFit));
      // Grown past the zoom: fit again rather than leave it below fit.
      if (wasFitted || current.scale <= fitted.scale) return applyView(fitted);
      applyView(recenterView(current, naturalSize, previousBox, boxSize));
    },
    [applyView]
  );

  const readNatural = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const size = { width: img.naturalWidth, height: img.naturalHeight };
    naturalRef.current = size;
    setNatural(size);
    viewRef.current = null;
    reconcile(null);
  }, [reconcile]);

  // A new image starts over at fit.
  useLayoutEffect(() => {
    naturalRef.current = null;
    setNatural(null);
    applyView(null);
    pinchRef.current = null;
    pressRef.current = null;
    setDragging(false);
    if (imgRef.current?.complete) readNatural();
  }, [src, applyView, readNatural]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const next = { width: root.clientWidth, height: root.clientHeight };
      const previous = boxRef.current;
      if (previous && previous.width === next.width && previous.height === next.height) return;
      boxRef.current = next;
      setBox(next);
      reconcile(previous);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [reconcile]);

  useEffect(() => {
    if (!autoFocus) return;
    const root = rootRef.current;
    if (!root) return;
    const active = document.activeElement;
    const dialog = root.closest('[role="dialog"]');
    if (!active || active === document.body || (dialog && dialog.contains(active))) {
      root.focus({ preventScroll: true });
    }
  }, [autoFocus]);

  const zoomTo = useCallback(
    (scale: number, anchor?: Point) => {
      const g = geometry();
      if (!g) return;
      applyView(zoomAround(g.view, scale, anchor ?? center(g), g.natural, g.box, g.fit), true);
    },
    [applyView, geometry]
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      const g = geometry();
      if (!g) return;
      zoomTo(stepScale(g.view.scale, direction, g.fit));
    },
    [geometry, zoomTo]
  );

  const fit = useCallback(() => {
    const g = geometry();
    if (!g) return;
    applyView(fittedView(g.natural, g.box, paddingRef.current, maxFitRef.current), true);
  }, [applyView, geometry]);

  // Wheel and WebKit gesture listeners must be non-passive to preventDefault.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      const g = geometry();
      if (event.ctrlKey || event.metaKey) {
        // Pinch (Chromium) or Ctrl/⌘+wheel: zoom the image, never the page.
        event.preventDefault();
        if (!g || pinchRef.current) return;
        const deltaY = wheelDeltaPx(event.deltaY, event.deltaMode, g.box.height);
        const anchor = toElementPx(root, event.clientX, event.clientY);
        applyView(
          zoomAround(
            g.view,
            g.view.scale * wheelZoomFactor(deltaY),
            anchor,
            g.natural,
            g.box,
            g.fit
          )
        );
        return;
      }
      // Nothing to pan: leave the wheel to whatever scrolls around the viewer.
      if (!g || !canPan(g.view, g.natural, g.box)) return;
      event.preventDefault();
      let dx = wheelDeltaPx(event.deltaX, event.deltaMode, g.box.width);
      let dy = wheelDeltaPx(event.deltaY, event.deltaMode, g.box.height);
      if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0];
      applyView(panView(g.view, -dx, -dy, g.natural, g.box));
    };
    const onGestureStart = (raw: Event) => {
      const event = raw as WebKitGestureEvent;
      event.preventDefault();
      const g = geometry();
      if (!g || !Number.isFinite(event.scale) || event.scale <= 0) return;
      const anchor =
        typeof event.clientX === 'number' && typeof event.clientY === 'number'
          ? toElementPx(root, event.clientX, event.clientY)
          : center(g);
      pinchRef.current = { from: g.view, anchor };
    };
    const onGestureChange = (raw: Event) => {
      const event = raw as WebKitGestureEvent;
      event.preventDefault();
      const pinch = pinchRef.current;
      const g = geometry();
      if (!pinch || !g || !Number.isFinite(event.scale) || event.scale <= 0) return;
      applyView(
        zoomAround(
          pinch.from,
          pinch.from.scale * event.scale,
          pinch.anchor,
          g.natural,
          g.box,
          g.fit
        )
      );
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      pinchRef.current = null;
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('gesturestart', onGestureStart, { passive: false });
    root.addEventListener('gesturechange', onGestureChange, { passive: false });
    root.addEventListener('gestureend', onGestureEnd, { passive: false });
    return () => {
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('gesturestart', onGestureStart);
      root.removeEventListener('gesturechange', onGestureChange);
      root.removeEventListener('gestureend', onGestureEnd);
    };
  }, [applyView, geometry]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // ⌘/Ctrl/Alt combos belong to the app (⌘+ / ⌘− / ⌘0 are its UI zoom).
    if (event.metaKey || event.ctrlKey || event.altKey || fromOutside(event)) return;
    const g = geometry();
    if (!g) return;
    const pan = KEY_PAN[event.key];
    if (event.key === '+' || event.key === '=') step(1);
    else if (event.key === '-') step(-1);
    else if (event.key === '0') fit();
    else if (event.key === '1') zoomTo(1);
    else if (pan && canPan(g.view, g.natural, g.box)) {
      const [sx, sy] = pan;
      applyView(
        panView(
          g.view,
          sx * g.box.width * KEY_PAN_SHARE,
          sy * g.box.height * KEY_PAN_SHARE,
          g.natural,
          g.box
        ),
        true
      );
    } else return;
    event.preventDefault();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || inToolbar(event.target) || fromOutside(event)) return;
    const g = geometry();
    const pannable = !!g && canPan(g.view, g.natural, g.box);
    pressRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      from: pannable && g ? g.view : null,
    };
    if (!pannable) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    setAnimate(false);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    const root = rootRef.current;
    if (!press || press.pointerId !== event.pointerId || !root) return;
    const dx = event.clientX - press.clientX;
    const dy = event.clientY - press.clientY;
    if (!press.moved && Math.hypot(dx, dy) > CLICK_SLOP) press.moved = true;
    const g = geometry();
    if (!press.from || !g) return;
    const scale = elementPxScale(root);
    applyView(panView(press.from, dx / scale, dy / scale, g.natural, g.box));
  };

  const endPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    pressRef.current = null;
    suppressClickRef.current = press.moved;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (inToolbar(event.target) || fromOutside(event)) return;
    const g = geometry();
    const root = rootRef.current;
    if (!g || !root) return;
    if (!isAtFit(g.view.scale, g.fit)) return fit();
    zoomTo(detailScale(g.fit), toElementPx(root, event.clientX, event.clientY));
  };

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const dragged = suppressClickRef.current;
    suppressClickRef.current = false;
    if (!onBackdropClick || dragged || inToolbar(event.target) || fromOutside(event)) return;
    if (event.target === imgRef.current) return;
    const g = geometry();
    if (g && !isAtFit(g.view.scale, g.fit)) return;
    onBackdropClick();
  };

  const ready = !!natural && isPositive(box) && !!view;
  const fitValue = ready ? fitScale(natural, box, fitPadding, maxFitScale) : 1;
  const atFit = ready ? isAtFit(view.scale, fitValue) : true;
  const pannable = ready && canPan(view, natural, box);
  const atMax = ready && view.scale >= Math.max(fitValue, MAX_SCALE) - 1e-6;
  const percent = ready ? Math.round(view.scale * 100) : 100;

  // A toolbar button that just disabled itself (− at fit, + at 8×, Fit)
  // drops focus to <body> and the viewer's keys with it; hand focus back.
  const pressedButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const pressed = pressedButtonRef.current;
    pressedButtonRef.current = null;
    if (pressed?.disabled) rootRef.current?.focus({ preventScroll: true });
  });
  const toolbarAction = (action: () => void) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    pressedButtonRef.current = event.currentTarget;
    action();
  };

  return (
    <div
      ref={rootRef}
      className={cn(styles.viewer, className)}
      role="group"
      aria-label="Image viewer"
      aria-describedby={hintId}
      tabIndex={0}
      data-pannable={pannable || undefined}
      data-dragging={dragging || undefined}
      data-zoomed={!atFit || undefined}
      data-backdrop={(onBackdropClick && atFit) || undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
    >
      <img
        {...imageDataAttributes}
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        className={cn(styles.image, imageClassName)}
        data-ready={ready ? 'true' : 'false'}
        data-animate={animate ? 'true' : undefined}
        style={
          ready
            ? {
                width: natural.width * view.scale,
                height: natural.height * view.scale,
                transform: `translate(${view.x}px, ${view.y}px)`,
              }
            : undefined
        }
        onLoad={readNatural}
      />
      {ready && overlay && (
        <div
          className={styles.overlay}
          data-animate={animate ? 'true' : undefined}
          style={{
            width: natural.width,
            height: natural.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          {overlay({ natural, view })}
        </div>
      )}
      <span id={hintId} className={styles.srOnly}>
        Plus and minus zoom, 0 fits, 1 shows actual size; drag or use the arrow keys to move a
        zoomed image.
      </span>
      {ready && (
        <div
          className={styles.toolbar}
          role="group"
          aria-label="Zoom controls"
          data-image-viewer-toolbar=""
        >
          <Tooltip label="Zoom out (−)" side="top">
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label="Zoom out"
              disabled={atFit}
              onClick={toolbarAction(() => step(-1))}
            >
              <MinusIcon />
            </Button>
          </Tooltip>
          <output className={styles.readout} aria-live="polite" aria-atomic="true">
            <span className={styles.srOnly}>Zoom </span>
            {percent}%
          </output>
          <Tooltip label="Zoom in (+)" side="top">
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label="Zoom in"
              disabled={atMax}
              onClick={toolbarAction(() => step(1))}
            >
              <PlusIcon />
            </Button>
          </Tooltip>
          <Tooltip label="Fit to view (0)" side="top">
            <Button
              variant="ghost"
              size="xs"
              className={styles.fitButton}
              aria-label="Fit image to view"
              disabled={atFit}
              onClick={toolbarAction(fit)}
            >
              Fit
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
};
