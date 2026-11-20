/**
 * The calendar's own ordered undo stack.
 *
 * Every calendar write (move, resize, create, delete, popover edit) records
 * one step. Row steps undo through the table history (`tableHistory`, with
 * the step id they made, so a stale step is refused instead of reverting
 * something else); event steps by a reverse PATCH or an archive restore.
 *
 * Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z are handled in the capture phase on the
 * window, only while the calendar pane is active and focus is not in a text
 * field or dialog. While active the calendar always consumes the shortcut,
 * even with an empty stack, so the window-wide workspace undo never reverts
 * an old tree move from the calendar. The toast's Undo runs the same stack.
 */
import { useEffect, useRef } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { dismissToast, showToast } from '@desktop/utils/toast';

export interface UndoableStep {
  label: string;
  undo: () => Promise<void>;
  /** Re-apply after an undo; steps without it drop off when undone. */
  redo?: () => Promise<void>;
}

const DEPTH = 50;
let done: UndoableStep[] = [];
let undone: UndoableStep[] = [];
let queue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
/** The "… · Undo" toast of each step, closed once the step is undone or redone. */
const toastIds = new WeakMap<UndoableStep, string>();
let toastSeq = 0;

function closeToastOf(step: UndoableStep): void {
  const id = toastIds.get(step);
  if (id === undefined) return;
  toastIds.delete(step);
  dismissToast(id);
}

function changed(): void {
  for (const listener of listeners) listener();
}

/** Called after every undo / redo, e.g. so the pane refetches its window. */
export function onCalendarUndoChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordStep(step: UndoableStep): void {
  done.push(step);
  if (done.length > DEPTH) done = done.slice(-DEPTH);
  undone = [];
}

/** Record `step` and show the "… · Undo" toast (6 s, the toast host's rules). */
export function offerUndo(message: string, step: UndoableStep): void {
  recordStep(step);
  let ran = false;
  const id = `calendar-undo-${++toastSeq}`;
  toastIds.set(step, id);
  showToast(message, {
    id,
    action: {
      label: 'Undo',
      run: () => {
        if (ran) return;
        ran = true;
        void undoCalendarStep(step);
      },
    },
  });
}

function run(work: () => Promise<void>): Promise<void> {
  queue = queue.then(work).finally(changed);
  return queue;
}

/**
 * Undo `step` (default: the newest). Out-of-order undo from an older toast
 * takes that step off the stack; only the newest one can be redone after.
 */
export function undoCalendarStep(step?: UndoableStep): Promise<void> {
  const target = step ?? done[done.length - 1];
  if (!target) return queue;
  const index = done.lastIndexOf(target);
  if (index === -1) return queue; // already undone
  const newest = index === done.length - 1;
  done.splice(index, 1);
  // Undone by any route (shortcut, toast, menu): its Undo toast goes away.
  closeToastOf(target);
  return run(async () => {
    try {
      await target.undo();
      if (newest && target.redo) undone.push(target);
    } catch (err: unknown) {
      showToast(getErrorMessage(err, `Couldn't undo “${target.label}”`));
    }
  });
}

export function redoCalendarStep(): Promise<void> {
  const target = undone.pop();
  if (!target?.redo) return queue;
  const redo = target.redo;
  closeToastOf(target);
  return run(async () => {
    try {
      await redo();
      done.push(target);
    } catch (err: unknown) {
      showToast(getErrorMessage(err, `Couldn't redo “${target.label}”`));
    }
  });
}

export function calendarUndoState(): { undo: string | null; redo: string | null } {
  return {
    undo: done[done.length - 1]?.label ?? null,
    redo: undone[undone.length - 1]?.label ?? null,
  };
}

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'time',
  'month',
  'week',
]);

function inTextOrDialog(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target.isContentEditable) return true;
  return (
    target.closest(
      '[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="dialog"]'
    ) !== null
  );
}

/**
 * Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z (redo) for the calendar pane, in
 * the capture phase, while `active` (the pane is the active one).
 */
export function useCalendarUndoShortcuts(active: boolean): void {
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'z') return;
      if (inTextOrDialog(event.target) || inTextOrDialog(document.activeElement)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      // Ours, even when the stack is empty: never fall through to the
      // window-wide workspace undo.
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) void redoCalendarStep();
      else void undoCalendarStep();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}

/** @public Test isolation for the module-level stack. */
export function __resetCalendarUndoForTests(): void {
  done = [];
  undone = [];
  queue = Promise.resolve();
  listeners.clear();
}
