import type { KeyboardEvent, PointerEvent } from 'react';
import type {
  Calendar,
  CalendarIntervalSpan,
  CalendarOccurrence,
  CalendarOccurrenceTime,
} from '@snaglet/shared/types';
import type { QuickAddSlot } from '@desktop/features/calendar/QuickAddPopover';
import type { DragKind } from './dropTargets';

/** What the item context menu needs from the press: the item it anchors to and where. */
export interface ItemMenuEvent {
  currentTarget: HTMLElement;
  clientX: number;
  clientY: number;
}

/** A drag in progress: the grid draws the ghost at `time`. */
export interface DragPreview {
  occurrence: CalendarOccurrence;
  /** Last valid place (the original until the first valid one). */
  time: CalendarOccurrenceTime;
  /** False over an invalid zone: ghost in --color-disabled. */
  valid: boolean;
  /** "Tue 10:15 – 10:45 AM". */
  label: string;
}

export interface GridProps {
  days: string[];
  today: string;
  zone: string;
  occurrences: CalendarOccurrence[];
  /** Every automations: a span per day each is active, drawn as a line (Week / Day) or a dot (Month). */
  intervals?: CalendarIntervalSpan[];
  /** Opens an Every automation's popover at `anchor`, from its line or dot (`opener`). */
  onOpenInterval?: (span: CalendarIntervalSpan, anchor: HTMLElement, opener: HTMLElement) => void;
  calendarsById: ReadonlyMap<string, Calendar>;
  colorOf: (calendarId: string) => string;
  narrow: boolean;
  /** The pending quick-add slot, drawn as a ghost. */
  draft: QuickAddSlot | null;
  /** Color id of the calendar a new event lands in: the draft / sweep ghost wears it. */
  draftColor?: string;
  /** The grid reports the element the quick-add popover anchors to. */
  onDraft: (slot: QuickAddSlot, anchor: HTMLElement) => void;
  /** A day picked in the sidebar mini month: Week / 3-day mark it with a focus ring. */
  focusDay?: string | null;
  onOpenItem: (o: CalendarOccurrence, el: HTMLElement, focusTitle?: boolean) => void;
  onOpenDay: (day: string) => void;
  onItemKeyDown: (event: KeyboardEvent<HTMLButtonElement>, o: CalendarOccurrence) => void;
  /** Ref callback for the ghost element so the popover can anchor to it. */
  ghostRef: (el: HTMLElement | null) => void;
  /** The items shown belong to this range (not the previous one's, mid-load). */
  itemsReady?: boolean;
  /** The drag in progress, if any. */
  dragPreview?: DragPreview | null;
  onItemDragStart?: (
    event: PointerEvent<HTMLElement>,
    o: CalendarOccurrence,
    kind: DragKind
  ) => void;
  onItemContextMenu?: (event: ItemMenuEvent, o: CalendarOccurrence) => void;
}
