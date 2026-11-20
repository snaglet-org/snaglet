/**
 * Moving and resizing from the calendar pane: pointer drags, Alt+arrow
 * keyboard moves, and "Move to…". One commit path for all of them:
 *
 * 1. same place → nothing;
 * 2. repeating row moved → ask "Only this one" / "All upcoming" at the drop
 *    point (a resize never asks: a range row's new length applies to every
 *    later occurrence);
 * 3. optimistic: draw the item at its new time now;
 * 4. `commitMove` (event PATCH / row update / repeat move|shift), which records the
 *    step on the calendar undo stack and shows the "Moved … · Undo" toast;
 * 5. on failure: put it back, toast why (a 409 also refetches).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { CalendarOccurrence, CalendarOccurrenceTime } from '@snaglet/shared/types';
import { reportWriteError, isConflict } from '@desktop/features/calendar/eventActions';
import { startCalendarDrag } from '@desktop/features/calendar/calendarDrag';
import { describeTime, sameTime } from '@desktop/features/calendar/occurrenceMoves';
import {
  canShiftAll,
  commitMove,
  needsRepeatChoice,
  type RepeatMoveMode,
} from '@desktop/features/calendar/occurrenceWrites';
import { displayTitle } from './occurrenceText';
import { grabOf, resolveDrop, zoneAt, type DragKind } from './dropTargets';
import type { DragPreview } from './gridTypes';

export interface RepeatChoiceState {
  occurrence: CalendarOccurrence;
  after: CalendarOccurrenceTime;
  anchor: HTMLElement;
  target: string;
  canShiftAll: boolean;
  verb: 'Moved' | 'Resized';
}

interface Options {
  rootRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  zone: string;
  patchLocal: (update: (list: CalendarOccurrence[]) => CalendarOccurrence[]) => void;
  refetch: () => void;
  announce: (text: string) => void;
  /** Called after a successful write (e.g. keep focus on the moved item). */
  onCommitted?: (o: CalendarOccurrence) => void;
  /** The snap step in minutes for a timed drag (it follows the zoom). */
  snapStep?: () => number;
}

function withTime(o: CalendarOccurrence, time: CalendarOccurrenceTime): CalendarOccurrence {
  return { ...o, time };
}

export function useCalendarMoves({
  rootRef,
  scrollRef,
  zone,
  patchLocal,
  refetch,
  announce,
  onCommitted,
  snapStep,
}: Options) {
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [choice, setChoice] = useState<RepeatChoiceState | null>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);

  const write = useCallback(
    async (
      o: CalendarOccurrence,
      after: CalendarOccurrenceTime,
      verb: 'Moved' | 'Resized',
      mode?: RepeatMoveMode
    ) => {
      const title = displayTitle(o);
      const resize = verb === 'Resized';
      const message = `${verb} ${title} to ${describeTime(after, zone, resize ? 'range' : 'start')}`;
      patchLocal((list) => list.map((x) => (x.key === o.key ? withTime(x, after) : x)));
      try {
        await commitMove(o, after, {
          zone,
          message,
          kind: resize ? 'resize' : 'move',
          ...(mode ? { mode } : {}),
          label: `${resize ? 'Resize' : 'Move'} ${title}`,
        });
        announce(message);
        onCommitted?.(o);
        // Repeating rows change other occurrences (and keys): reload the window.
        if (o.source === 'row') refetch();
      } catch (err) {
        patchLocal((list) => list.map((x) => (x.key === o.key ? withTime(x, o.time) : x)));
        reportWriteError(err, `Couldn't move ${title}`);
        if (isConflict(err)) refetch();
      }
    },
    [zone, patchLocal, refetch, announce, onCommitted]
  );

  /** Commit a new time for `o` (drag drop, Alt+arrows, Move to…). */
  const commit = useCallback(
    (
      o: CalendarOccurrence,
      after: CalendarOccurrenceTime,
      anchor: HTMLElement | null,
      verb: 'Moved' | 'Resized' = 'Moved'
    ) => {
      if (!o.canMove || sameTime(o.time, after)) return;
      if (verb === 'Moved' && needsRepeatChoice(o)) {
        const el = anchor ?? rootRef.current;
        if (!el) return;
        setChoice({
          occurrence: o,
          after,
          anchor: el,
          target: describeTime(after, zone),
          canShiftAll: canShiftAll(o),
          verb,
        });
        return;
      }
      void write(o, after, verb);
    },
    [write, zone, rootRef]
  );

  const choose = useCallback(
    (mode: RepeatMoveMode) => {
      if (!choice) return;
      setChoice(null);
      setDragPreview(null);
      void write(choice.occurrence, choice.after, choice.verb, mode);
    },
    [choice, write]
  );
  const cancelChoice = useCallback(() => {
    setChoice(null);
    setDragPreview(null); // snaps back: no request
  }, []);

  const onItemDragStart = useCallback(
    (event: PointerEvent<HTMLElement>, o: CalendarOccurrence, kind: DragKind) => {
      if (!o.canMove || (kind !== 'move' && !o.canResize)) return;
      const item = (event.currentTarget.closest('[data-calendar-item]') ??
        event.currentTarget) as HTMLElement;
      const root = rootRef.current;
      const grab = grabOf(o.time, zoneAt(root, event.clientX, event.clientY), event.clientY, zone);
      // A range row's resized edge may land on another day.
      const acrossDays = o.source === 'row' && o.range;
      const step = snapStep?.();
      let last: CalendarOccurrenceTime = o.time;
      let keepGhost = false;
      cancelDrag.current?.();
      cancelDrag.current = startCalendarDrag<CalendarOccurrenceTime>({
        item,
        scroller: scrollRef.current,
        startX: event.clientX,
        startY: event.clientY,
        cursor:
          kind === 'move' ? 'grabbing' : o.time.kind === 'all_day' ? 'ew-resize' : 'ns-resize',
        resolve: (x, y) =>
          resolveDrop(o.time, kind, zoneAt(root, x, y), y, grab, zone, acrossDays, step),
        onPreview: (time) => {
          if (time) last = time;
          setDragPreview({
            occurrence: o,
            time: last,
            valid: time !== null,
            label: describeTime(last, zone, 'range'),
          });
        },
        onDrop: (time) => {
          const verb = kind === 'move' ? 'Moved' : 'Resized';
          if (kind === 'move' && needsRepeatChoice(o) && !sameTime(o.time, time)) {
            // Keep the ghost at the drop point; the choice popover anchors to it.
            keepGhost = true;
            const ghost = root?.querySelector<HTMLElement>('[data-calendar-drag-ghost]');
            commit(o, time, ghost ?? item, verb);
            return;
          }
          commit(o, time, item, verb);
        },
        onEnd: () => {
          if (!keepGhost) setDragPreview(null);
          cancelDrag.current = null;
        },
      });
    },
    [rootRef, scrollRef, zone, commit, snapStep]
  );

  return { dragPreview, onItemDragStart, commit, choice, choose, cancelChoice };
}
