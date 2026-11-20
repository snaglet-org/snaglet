/**
 * Last user input modality, shared by every pane. Focus moving into a pane
 * activates it only when the user got there by keyboard (Tab, a shortcut);
 * pointer presses activate through mousedown, and focus that a view moves on
 * its own — an editor autofocusing on mount — leaves the active pane alone.
 */

type InputModality = 'keyboard' | 'pointer';

let lastModality: InputModality | null = null;
let subscribers = 0;

const onKeyDown = () => {
  lastModality = 'keyboard';
};
const onPointerDown = () => {
  lastModality = 'pointer';
};

/** Start tracking; returns the cleanup. Listeners are shared across callers. */
export function trackInputModality(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (subscribers === 0) {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('mousedown', onPointerDown, true);
  }
  subscribers += 1;
  return () => {
    subscribers -= 1;
    if (subscribers > 0) return;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('mousedown', onPointerDown, true);
    lastModality = null;
  };
}

export function lastInputWasKeyboard(): boolean {
  return lastModality === 'keyboard';
}
