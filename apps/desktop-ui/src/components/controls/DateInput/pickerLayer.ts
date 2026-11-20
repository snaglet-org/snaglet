/**
 * The open date picker is the topmost layer: one Escape closes it and
 * nothing beneath it, and presses inside it are never "outside" for the
 * surface the field lives in.
 *
 * The picker takes Escape in the window's capture phase and stops it, which
 * covers every bubble-phase and React handler. A surface that also listens in
 * the window's capture phase (RepeatSurface) registered first, so it asks
 * here before acting; a surface with its own DOM outside-press test asks
 * `isInsideDatePicker`.
 *
 * Pickers stack: a field inside an open picker (the Repeat view's end date)
 * opens a picker above it. Only the top one takes Escape and outside
 * presses, so each closes one layer, and a surface beneath an open picker
 * leaves the press to it.
 */

const openPickers: object[] = [];

/** On the popover; `[data-keeps-cell]` sits next to it for the table grid. */
export const DATE_PICKER_ATTR = 'data-date-picker';
/** On a field whose typed text is not committed yet: Escape reverts it first. */
export const DATE_PENDING_ATTR = 'data-date-pending';

/** Marks `layer` (any stable object) open, on top of the others; returns its close. */
export function registerOpenDatePicker(layer: object = {}): () => void {
  openPickers.push(layer);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const at = openPickers.lastIndexOf(layer);
    if (at >= 0) openPickers.splice(at, 1);
  };
}

/** Whether `layer` is the topmost open picker (a picker opened from inside it is above it). */
export function isTopDatePicker(layer: object): boolean {
  return openPickers[openPickers.length - 1] === layer;
}

/** Whether this Escape belongs to a date field: its open picker, or its typed text. */
export function datePickerOwnsEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape') return false;
  if (openPickers.length > 0) return true;
  return isPendingDateField(event.target);
}

/** A field whose typed text Escape reverts before anything closes. */
export function isPendingDateField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${DATE_PENDING_ATTR}]`) !== null;
}

export function isInsideDatePicker(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${DATE_PICKER_ATTR}]`) !== null;
}
