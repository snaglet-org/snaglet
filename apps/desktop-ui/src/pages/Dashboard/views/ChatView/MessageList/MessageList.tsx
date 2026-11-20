import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import type { ThreadTrimSides } from '@snaglet/shared/types';
import type { ThreadMessage } from '@desktop/utils/api';
import type { ConversationFindTarget } from '@desktop/features/pane-find/useConversationFind';
import { highlightConversation } from '@desktop/features/pane-find/highlightConversation';
import { MessageRow, type MessageAuthor } from '../MessageRow/MessageRow';
import type { MemoryExtractionNotice, RunActivity } from '../hooks/types';
import type { PageError } from '../hooks/useThreadHistory';
import { activityStepsSignature } from '../hooks/chatStreamHelpers';
import type { RenderMode } from '../ChatView';
import { Button } from '@desktop/components';
import { setChatAutoScroll, useChatAutoScroll } from '@desktop/utils/displayPrefs';
import { compareInstants } from '@desktop/utils/chronology';
import styles from './MessageList.module.scss';

/**
 * The cut the trim panel is proposing, as the server resolved it. Always the
 * resolved plan, never the raw handle request: the server widens the kept range
 * to keep agent runs whole, and the user has to see the cut that will happen.
 */
export interface TrimOverlay {
  firstRetainedId: string;
  lastRetainedId: string;
  /** Which sides the resolved plan really cuts. */
  sides: ThreadTrimSides;
  /**
   * Boundary to bring into view, or null until the user asks for one. Set by
   * scrubbing a handle and by the "Jump to prefix/tail" buttons alike — one
   * mechanism, so the two entry points cannot diverge.
   *
   * `nonce` is what the pane keys on, not `messageId`: asking for the same
   * boundary twice (jump there, scroll away, jump again) must seek twice, and
   * nothing else re-renders it into seeking.
   */
  seek: { messageId: string; nonce: number } | null;
}

interface MessageListProps {
  find?: ConversationFindTarget | null;
  messages: ThreadMessage[];
  activities: Map<string, RunActivity>;
  agentNameById: Map<string, string>;
  loading: boolean;
  /**
   * True when the history failed to load. An empty list is then not an empty
   * thread, so it must not say "No messages yet" (the view reports the
   * failure itself).
   */
  failed?: boolean;
  /** The view shows its own empty state (an empty thread's suggestions), so say nothing here. */
  hideEmptyNote?: boolean;
  renderMode: RenderMode;
  /** When true, render a "Load more" button at the top of the list. */
  hasMoreOlder?: boolean;
  /**
   * When true, the loaded window doesn't include the live tail — the
   * list auto-loads forward when the user scrolls past the bottom.
   */
  hasMoreNewer?: boolean;
  /** True while either pagination request is in flight. */
  paginating?: boolean;
  /** The last older/newer page that failed to load, shown at that end of the list. */
  pageError?: PageError | null;
  /** Fire to prepend an older page. */
  onLoadOlder?: () => void;
  /** Fire to append a newer page. */
  onLoadNewer?: () => void;
  /**
   * Message the list lands on, holds in view and highlights once it loads,
   * until the user scrolls or clicks in the list. Set when the chat view
   * opened on a message (a message chip or a search hit).
   */
  focusMessageId?: string | null;
  /** Changes per message-focus navigation; lands a repeated id again. */
  focusRequestId?: number | null;
  /**
   * False when `focusMessageId` only re-centers the view (a reload after a
   * trim, which every open view of the thread gets): the list lands on it
   * without holding or highlighting it.
   */
  holdFocus?: boolean;
  /**
   * When set, the list doubles as the trim panel's viewer: messages the plan
   * removes render dimmed in place, and moving a handle seeks the pane to that
   * boundary. Null whenever the trim panel is closed.
   */
  trim?: TrimOverlay | null;
  /**
   * Ephemeral compaction-time memory-extraction notices, interleaved into the
   * stream by arrival time. Pane-local: never persisted, gone on reload.
   */
  memoryExtractions?: MemoryExtractionNotice[];
  /** Click on a memory-extraction notice: show that agent's memories (proposed ones first). */
  onOpenMemoryNotice?: (agentId: string) => void;
  /**
   * Author (avatar + name) for a row, shown beside its bubble. The DM reading
   * pane sets it; ordinary threads leave it unset. Return the same object for
   * the same author, or rows lose their memo.
   */
  authorFor?: (row: { message?: ThreadMessage; activity?: RunActivity }) => MessageAuthor | null;
  /** Small avatar inside each agent bubble's name tag. */
  tagAvatarFor?: (agentId: string) => ReactNode;
}

const FORWARD_LOAD_NEAR_BOTTOM_PX = 64;

/** Space left above a focused message too tall to center, so its first line shows. */
export const FOCUS_TOP_MARGIN_PX = 12;

/**
 * The scrollTop that brings a focused message into view: centered when it fits,
 * otherwise top-aligned with a small margin, because centering a tall message
 * shows its middle and hides which message it is.
 */
export function focusScrollTop(
  row: { top: number; height: number },
  view: { height: number; maxScrollTop: number }
): number {
  const fits = row.height + 2 * FOCUS_TOP_MARGIN_PX <= view.height;
  const desired = fits ? row.top - (view.height - row.height) / 2 : row.top - FOCUS_TOP_MARGIN_PX;
  return Math.min(Math.max(0, desired), Math.max(0, view.maxScrollTop));
}

/** A focused message's offset in the scrolled content, its height, and the view height. */
interface FocusGeometry {
  top: number;
  height: number;
  view: number;
}

/**
 * Measured in the list's own (unscaled) pixels, the unit scrollTop uses. Client
 * rects include transforms, and a modal's entrance animation scales the list
 * while the message lands.
 */
function focusGeometry(list: HTMLElement, target: HTMLElement): FocusGeometry {
  const rect = target.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  // Under a pixel apart is rounding, not a transform.
  const scaled = list.offsetHeight > 0 && Math.abs(listRect.height - list.offsetHeight) >= 1;
  const scale = scaled ? listRect.height / list.offsetHeight : 1;
  return {
    top: (rect.top - listRect.top) / scale - list.clientTop + list.scrollTop,
    height: rect.height / scale,
    view: list.clientHeight,
  };
}

function sameGeometry(a: FocusGeometry, b: FocusGeometry): boolean {
  return Math.abs(a.top - b.top) <= 1 && Math.abs(a.height - b.height) <= 1 && a.view === b.view;
}

function focusScrollTopFor(list: HTMLElement, geometry: FocusGeometry): number {
  return focusScrollTop(geometry, {
    height: geometry.view,
    maxScrollTop: list.scrollHeight - list.clientHeight,
  });
}

/**
 * Render cap: only the newest MAX_RENDERED rows render, because each row's
 * markdown is costly. Older messages stay in useChatStream's `messages`.
 */
export const MAX_RENDERED = 200;

/**
 * Rows rendered either side of a sought row that the tail cap dropped. A seek
 * adds this bounded span instead of uncapping, so at most
 * MAX_RENDERED + 2 * SEEK_CONTEXT_ROWS + 1 rows render. The tail span stays,
 * so streaming and optimistic bubbles at the end of `rows` never unrender.
 */
export const SEEK_CONTEXT_ROWS = 40;

/**
 * How many pages one seek may pull in before the pane gives up on the boundary.
 * At the 50-message page size that is 1000 messages: deep enough for a real
 * jump, finite so a boundary deleted mid-plan cannot spin forever.
 */
export const MAX_SEEK_PAGE_LOADS = 20;

const NEAR_BOTTOM_PX = 24;
/** A scroll this soon after wheel/touch/key/pointer input counts as the user's. */
const USER_SCROLL_INTENT_MS = 600;

interface Row {
  key: string;
  /** Persisted/streaming message, or undefined for an activity-only stub. */
  message?: ThreadMessage;
  /** The run's activity, when this row is the "final" message of the run. */
  activity?: RunActivity;
  /** Ephemeral memory-extraction notice — renders as a quiet meta line. */
  extraction?: MemoryExtractionNotice;
  sortKey: string;
}

/**
 * A drop in an agent's per-turn `usage.inputTokens` past this ratio counts as
 * a context compaction. The prompt only shrinks when the context is compacted;
 * the 10% margin keeps provider token-count jitter from drawing a divider.
 */
const COMPACTION_DROP_RATIO = 0.9;

/**
 * Ids of the messages that sit right after a context compaction, so the list
 * draws a divider above them. Compares each assistant message's
 * `usage.inputTokens` to the same agent's previous one
 * ({@link COMPACTION_DROP_RATIO}), and also takes the server's
 * `usage.runCompactions` flag for a run that compacted mid-run. `rows` must be
 * in ascending order and uncapped, so a predecessor is always available.
 */
export function computeCompactionMessageIds(
  rows: ReadonlyArray<{ message?: ThreadMessage }>
): Set<string> {
  const compactionIds = new Set<string>();
  const lastInputByAgent = new Map<string, number>();
  for (const { message } of rows) {
    if (!message || message.role !== 'assistant' || !message.agentId) continue;
    if ((message.usage?.runCompactions ?? 0) > 0) compactionIds.add(message.id);
    const input = message.usage?.inputTokens;
    if (typeof input !== 'number' || input <= 0) continue;
    const prev = lastInputByAgent.get(message.agentId);
    if (prev != null && input < prev * COMPACTION_DROP_RATIO) {
      compactionIds.add(message.id);
    }
    // Track the latest size even on a drop: later turns grow from the
    // compacted baseline, so the next turn compares against this value.
    lastInputByAgent.set(message.agentId, input);
  }
  return compactionIds;
}

/** What the trim overlay resolves to against the rows actually on screen. */
export interface TrimView {
  /** Ids of loaded messages the resolved plan deletes. */
  doomedIds: Set<string>;
  /** True when the first kept message sits before the loaded window. */
  firstBoundaryAbove: boolean;
  /** True when the last kept message sits after the loaded window. */
  lastBoundaryBelow: boolean;
  /** True when neither boundary could be located among the loaded rows. */
  unlocatable: boolean;
}

const EMPTY_TRIM_VIEW: TrimView = {
  doomedIds: new Set(),
  firstBoundaryAbove: false,
  lastBoundaryBelow: false,
  unlocatable: false,
};

/**
 * Which loaded messages a trim plan would delete.
 *
 * Derived from the position of the boundary messages in the loaded list (the
 * server's `(created_at, id)` order), never from comparing timestamps:
 * `ThreadTrimBoundary.createdAt` is millisecond ISO and display-only, and a
 * boundary off by one row deletes or keeps a message against the user's
 * intent. When neither boundary is loaded, nothing is dimmed and the view is
 * flagged `unlocatable` rather than implying the visible messages are safe.
 */
export function computeTrimView(
  rows: ReadonlyArray<{ message?: ThreadMessage }>,
  trim: TrimOverlay | null | undefined
): TrimView {
  if (!trim || trim.sides === 'none') return EMPTY_TRIM_VIEW;

  const firstPos = rows.findIndex((r) => r.message?.id === trim.firstRetainedId);
  const lastPos = rows.findIndex((r) => r.message?.id === trim.lastRetainedId);
  if (firstPos < 0 && lastPos < 0) return { ...EMPTY_TRIM_VIEW, unlocatable: true };

  const cutsPrefix = trim.sides === 'prefix' || trim.sides === 'both';
  const cutsTail = trim.sides === 'tail' || trim.sides === 'both';
  const doomedIds = new Set<string>();

  if (cutsPrefix && firstPos >= 0) {
    for (const row of rows.slice(0, firstPos)) {
      if (row.message) doomedIds.add(row.message.id);
    }
  }
  if (cutsTail && lastPos >= 0) {
    for (const row of rows.slice(lastPos + 1)) {
      if (row.message) doomedIds.add(row.message.id);
    }
  }

  return {
    doomedIds,
    firstBoundaryAbove: cutsPrefix && firstPos < 0,
    lastBoundaryBelow: cutsTail && lastPos < 0,
    unlocatable: false,
  };
}

/**
 * Client-derived marker for where an agent's context was compacted: a muted
 * rule and a small chip, styled like the other meta lines so it reads as
 * metadata, not a message or an alarm.
 */
const CompactionDivider: FC = () => (
  <div className={styles.compactionDivider} role="separator" data-tid="compactionDivider">
    <span className={styles.compactionChip}>
      <svg
        className={styles.compactionIcon}
        viewBox="0 0 12 12"
        aria-hidden
        focusable="false"
        width="12"
        height="12"
      >
        {/* Two inward chevrons — a "compress" glyph, drawn in currentColor. */}
        <path
          d="M1.5 1.5 L4.5 6 L1.5 10.5 M10.5 1.5 L7.5 6 L10.5 10.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Agent context compacted
    </span>
  </div>
);

/**
 * Copy for a memory-extraction notice, e.g.
 * "Nova · 2 memories saved · 1 proposed for your approval". The agent-name
 * segment is skipped when the map hasn't resolved the id. All-zero notices
 * return null and are not rendered.
 */
export function memoryExtractionLabel(
  notice: Pick<MemoryExtractionNotice, 'saved' | 'proposed'>,
  agentName?: string | null
): string | null {
  const parts: string[] = [];
  if (notice.saved > 0) {
    parts.push(`${notice.saved} ${notice.saved === 1 ? 'memory' : 'memories'} saved`);
  }
  if (notice.proposed > 0) {
    parts.push(
      notice.saved > 0
        ? `${notice.proposed} proposed for your approval`
        : `${notice.proposed} ${notice.proposed === 1 ? 'memory' : 'memories'} proposed for your approval`
    );
  }
  if (parts.length === 0) return null;
  return [agentName, ...parts].filter(Boolean).join(' · ');
}

/**
 * Meta line for compaction-time memory extraction, styled like the other
 * quiet meta lines. Pane-local: gone on reload.
 */
const MemoryExtractionLine: FC<{
  notice: MemoryExtractionNotice;
  agentName?: string | null;
  /** Opens that agent's memories in the thread settings (pending proposals are listed first). */
  onOpen?: (agentId: string) => void;
}> = ({ notice, agentName, onOpen }) => {
  const label = memoryExtractionLabel(notice, agentName);
  if (label === null) return null;
  const content = (
    <>
      <span aria-hidden>🧠</span> {label}
    </>
  );
  return (
    <div className={styles.memoryExtraction} role="status" data-tid="memoryExtraction">
      {onOpen ? (
        <button
          type="button"
          className={styles.memoryExtractionLink}
          title={notice.proposed > 0 ? 'Review the proposed memories' : 'Open the memories'}
          onClick={() => onOpen(notice.agentId)}
        >
          {content}
        </button>
      ) : (
        content
      )}
    </div>
  );
};

/** Longest a seek will keep re-centering itself while the rows above settle. */
const SEEK_SETTLE_MS = 800;
/** Frames the target must hold still before the seek lets go of it. */
const SEEK_SETTLE_STABLE_FRAMES = 3;

/**
 * Hold the pane on a sought row while the rows above it settle. Freshly
 * mounted rows grow over the next frames as markdown and images lay out,
 * pushing the target out of view, so the position is re-asserted until the
 * target stops moving. Anything else that moves the scroll (the user's wheel)
 * ends the hold at once; {@link SEEK_SETTLE_MS} bounds it.
 */
function holdOnTarget(container: HTMLElement, target: HTMLElement): () => void {
  // Where the target sits in the scrolled content, which only changes when the
  // rows above it change size. Its viewport position is no use here: every
  // re-centering moves that by design.
  const contentTop = (): number =>
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop;

  let frame = 0;
  let stableFrames = 0;
  let lastTop = contentTop();
  let expectedScrollTop = container.scrollTop;
  const deadline = Date.now() + SEEK_SETTLE_MS;

  const tick = (): void => {
    // Something else moved the view (usually the user's wheel): let go.
    if (Math.abs(container.scrollTop - expectedScrollTop) > 2) return;
    const top = contentTop();
    if (Math.abs(top - lastTop) < 1) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
      lastTop = top;
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      expectedScrollTop = container.scrollTop;
    }
    if (stableFrames >= SEEK_SETTLE_STABLE_FRAMES || Date.now() > deadline) return;
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

/**
 * Tacked onto whichever offscreen-boundary marker is already showing, rather
 * than raised as a state of its own: a jump that could not land is the same
 * situation that marker describes, plus the fact that we tried.
 */
const SeekUnreachableNote: FC = () => (
  <span data-tid="seekUnreachable"> · the jump could not reach it</span>
);

/**
 * Pure presenter. A run persists one assistant message per utterance; its
 * activity disclosure folds into the last of them. A run with no message yet
 * (still thinking) renders as an activity-only stub at its start time.
 */
export const MessageList: FC<MessageListProps> = ({
  messages,
  activities,
  agentNameById,
  loading,
  failed = false,
  hideEmptyNote = false,
  renderMode,
  hasMoreOlder = false,
  hasMoreNewer = false,
  paginating = false,
  pageError = null,
  onLoadOlder,
  onLoadNewer,
  focusMessageId = null,
  focusRequestId = null,
  holdFocus = true,
  trim = null,
  memoryExtractions = [],
  onOpenMemoryNotice,
  find = null,
  authorFor,
  tagAvatarFor,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const findRequestRef = useRef<string | null>(null);
  // False until the initial jump to the bottom; then live output auto-follows.
  const autoFollowRef = useRef(false);
  // scrollTop our own tail pin last wrote: its delayed scroll event is not the
  // user scrolling away (content may have grown since), so it must not turn
  // following off. See handleScroll.
  const pinnedTopRef = useRef<number | null>(null);
  // The message a focus open already landed on, so a re-render never lands it
  // again after the user has moved on.
  const focusedIdRef = useRef<string | null>(null);
  // The navigation request the guard above belongs to. A new request (same
  // thread, possibly the same message) clears the guard so the message lands
  // again; a rerender with the same request leaves it alone.
  const focusedRequestRef = useRef<number | null>(null);
  const focusMessageIdRef = useRef(focusMessageId);
  focusMessageIdRef.current = focusMessageId;
  const focusRequestIdRef = useRef(focusRequestId);
  focusRequestIdRef.current = focusRequestId;
  // Message a navigation focus holds in view while the rows around it load and
  // resize, and the one it highlights. Both last until the user scrolls,
  // clicks, types or moves focus in the list, or another navigation moves the
  // view.
  const focusPinRef = useRef<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // True while the pin or highlight is set, so releasing is free otherwise.
  const focusHeldRef = useRef(false);
  // Keeps the focus target inside the render window (see activeAnchorId). It
  // outlives the pin, like a seek anchor: dropping it on the user's first touch
  // would unmount the rows they are reading. It goes when they follow the tail
  // again, jump to the latest, or the focus changes.
  const [focusAnchorId, setFocusAnchorId] = useState<string | null>(null);
  // Where placeFocusTarget last measured the pinned message, the scrollTop it
  // left and the largest scrollTop then. A scroll that moves the view while the
  // message's geometry is unchanged did not come from layout, so it is the
  // user's, unless content below shrank and the view was clamped to the end.
  const placedRef = useRef<{
    geometry: FocusGeometry;
    scrollTop: number;
    maxScrollTop: number;
  } | null>(null);
  const releaseFocus = useCallback(() => {
    // The current focus counts as handled: one that has not landed yet must not
    // pull the view away from the user when it does. Before its page arrives
    // the focus is still null, so scrolling the activity-only rows that load
    // first does not stop the landing; the user did ask for that message.
    focusedIdRef.current = focusMessageIdRef.current;
    focusedRequestRef.current = focusRequestIdRef.current;
    if (!focusHeldRef.current) return;
    focusHeldRef.current = false;
    focusPinRef.current = null;
    placedRef.current = null;
    setHighlightId(null);
  }, []);
  // When the user last did something that scrolls (see handleScroll).
  const userScrollIntentAtRef = useRef(Number.NEGATIVE_INFINITY);
  const markUserScrollIntent = useCallback(() => {
    userScrollIntentAtRef.current = performance.now();
    releaseFocus();
  }, [releaseFocus]);
  // Auto vs manual scroll (user preference, default auto). Manual never moves
  // the view on new output; the jump button brings the reader to the tail.
  const autoScroll = useChatAutoScroll();
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const [atBottom, setAtBottom] = useState(true);
  const following = () => autoScrollRef.current && autoFollowRef.current;
  const hasInitializedScrollRef = useRef(false);
  // scrollHeight before "Load more", so prepending the older page keeps the
  // user's viewport where it was.
  const restoreScrollRef = useRef<{ prevHeight: number } | null>(null);
  // Forward auto-load guard: true while an `onLoadNewer` is in flight.
  const forwardLoadingRef = useRef(false);
  // Last trim boundary scrubbed to. Seeking is keyed on the boundary
  // changing, so an unrelated re-render never moves the pane under a reader.
  const seekedBoundaryRef = useRef<number | null>(null);
  // Message the render window is anchored to, set when a seek targeted a row
  // the tail cap had dropped. Held by id rather than index: prepending an older
  // page shifts every index but never the identity of the boundary.
  const [seekAnchorId, setSeekAnchorId] = useState<string | null>(null);
  // Boundary a seek gave up on, so the pane can admit it rather than leave a
  // button that looks broken.
  const [unreachableSeekId, setUnreachableSeekId] = useState<string | null>(null);
  // Pages the current seek has already pulled in, and the nonce they belong to.
  const seekPageLoadsRef = useRef(0);
  const seekAttemptNonceRef = useRef<number | null>(null);
  // Cancels the settle loop that holds the pane on a landed seek. Held in a ref
  // rather than returned as effect cleanup so an unrelated re-render — a
  // message streaming in, say — cannot cut the hold short mid-settle.
  const seekHoldRef = useRef<(() => void) | null>(null);
  useEffect(() => () => seekHoldRef.current?.(), []);

  const isNearBottom = useCallback((el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  const findMessage = useCallback(
    (id: string) =>
      ref.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`) ?? null,
    []
  );

  // Put a focused message where a focus open places it: the pinned one by
  // default. Rows above it grow after it lands (the activity log, images,
  // diagrams), and WebKit has no scroll anchoring to absorb that, so every
  // layout change re-places it. The element is looked up each time: a row
  // remounts when its run's activity arrives.
  const placeFocusTarget = useCallback(
    (id: string | null = focusPinRef.current) => {
      const el = ref.current;
      const target = id ? findMessage(id) : null;
      if (!el || !target) return;
      const geometry = focusGeometry(el, target);
      const next = focusScrollTopFor(el, geometry);
      if (Math.abs(el.scrollTop - next) > 1) el.scrollTop = next;
      placedRef.current = {
        geometry,
        scrollTop: el.scrollTop,
        maxScrollTop: el.scrollHeight - el.clientHeight,
      };
    },
    [findMessage]
  );

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const pinned = focusPinRef.current ? findMessage(focusPinRef.current) : null;
    if (pinned) {
      const now = focusGeometry(el, pinned);
      const placed = placedRef.current;
      const maxScrollTop = el.scrollHeight - el.clientHeight;
      // Content below the message shrank and the engine clamped the view to
      // the new end: layout, not the user.
      const clampedToEnd =
        placed !== null &&
        maxScrollTop < placed.maxScrollTop &&
        maxScrollTop < placed.scrollTop &&
        Math.abs(el.scrollTop - maxScrollTop) <= 1;
      const userMoved =
        placed !== null &&
        !clampedToEnd &&
        sameGeometry(now, placed.geometry) &&
        Math.abs(el.scrollTop - placed.scrollTop) > 1;
      if (!userMoved) {
        // Layout moved the message (rows resized around it): put it back.
        pinnedTopRef.current = null;
        placeFocusTarget();
        const nearBottom = isNearBottom(el);
        setAtBottom((prev) => (prev === nearBottom ? prev : nearBottom));
        return;
      }
      // Nothing around the message moved, so the view did: the user scrolled by
      // a route with no input event here (assistive tech, keys sent elsewhere,
      // focus moving into the list). Let go and treat it as theirs.
      markUserScrollIntent();
    } else if (focusPinRef.current) {
      // The pinned message is gone (deleted): nothing to hold.
      releaseFocus();
    }
    const ownPin =
      pinnedTopRef.current != null && Math.abs(el.scrollTop - pinnedTopRef.current) <= 1;
    pinnedTopRef.current = null;
    const nearBottom = isNearBottom(el);
    setAtBottom((prev) => (prev === nearBottom ? prev : nearBottom));
    if (!ownPin) {
      // Reaching the bottom always resumes following. Leaving it only stops
      // following when the user scrolled (wheel, touch, keys, scrollbar): a
      // layout shift also fires scroll events and must not strand the view
      // above a streaming run.
      if (isNearBottom(el)) autoFollowRef.current = true;
      else if (performance.now() - userScrollIntentAtRef.current < USER_SCROLL_INTENT_MS)
        autoFollowRef.current = false;
    }
    // Back at the live tail with no jump outstanding: drop the anchored span
    // and return to the plain tail slice (invisible when pinned to the bottom).
    // The pending check matters: prepending an older page fires scroll events
    // that read "near bottom" while the new rows lay out, and clearing then
    // would lose the anchor the jump needs.
    const seekPending =
      seekAttemptNonceRef.current !== null &&
      seekedBoundaryRef.current !== seekAttemptNonceRef.current;
    if (autoFollowRef.current && !seekPending) {
      setSeekAnchorId((prev) => (prev === null ? prev : null));
      setFocusAnchorId((prev) => (prev === null ? prev : null));
    }
    // Forward auto-load when the window isn't the live tail (`hasMoreNewer`).
    // A distance threshold, so the next page arrives before the reader hits
    // the end.
    if (
      hasMoreNewer &&
      onLoadNewer &&
      !forwardLoadingRef.current &&
      el.scrollHeight - el.scrollTop - el.clientHeight <= FORWARD_LOAD_NEAR_BOTTOM_PX
    ) {
      forwardLoadingRef.current = true;
      Promise.resolve(onLoadNewer()).finally(() => {
        forwardLoadingRef.current = false;
      });
    }
  }, [
    isNearBottom,
    hasMoreNewer,
    onLoadNewer,
    findMessage,
    placeFocusTarget,
    markUserScrollIntent,
    releaseFocus,
  ]);

  const handleLoadOlder = useCallback(() => {
    if (!onLoadOlder || paginating) return;
    const el = ref.current;
    restoreScrollRef.current = { prevHeight: el?.scrollHeight ?? 0 };
    // The user is reading older content: don't snap back to the bottom.
    autoFollowRef.current = false;
    releaseFocus();
    onLoadOlder();
  }, [onLoadOlder, paginating, releaseFocus]);

  const rows = useMemo<Row[]>(() => {
    // The activity attaches to the last message of each run only.
    const lastIdxByRun = new Map<string, number>();
    messages.forEach((m, i) => {
      if (m.runId) lastIdxByRun.set(m.runId, i);
    });

    const list: Row[] = messages.map((m, i) => {
      const isLastOfRun = m.runId != null && lastIdxByRun.get(m.runId) === i;
      const activity = isLastOfRun && m.runId ? activities.get(m.runId) : undefined;
      // Rows with an activity key by `r:${runId}`, so the row stays mounted
      // (and its disclosure keeps its open state) while the run's message id
      // changes; other rows key by message id.
      const key = activity ? `r:${activity.runId}` : `m:${m.id}`;
      return {
        key,
        message: m,
        activity,
        sortKey: m.createdAt || '',
      };
    });

    // Stub rows for activities with no paired message yet.
    const pairedRuns = new Set<string>();
    for (const [runId, idx] of lastIdxByRun) {
      if (idx >= 0) pairedRuns.add(runId);
    }
    for (const activity of activities.values()) {
      if (pairedRuns.has(activity.runId)) continue;
      list.push({
        key: `r:${activity.runId}`, // same scheme as paired rows — keeps state stable across the stub→paired transition
        activity,
        sortKey: activity.startedAt || '',
      });
    }

    // Ephemeral memory-extraction notices interleave by arrival time, which
    // pins each one to the point in the stream where its compaction happened.
    // All-zero notices are skipped: they would read as a claim that nothing
    // was saved.
    for (const notice of memoryExtractions) {
      if (!(notice.saved > 0) && !(notice.proposed > 0)) continue;
      list.push({
        key: `x:${notice.id}`,
        extraction: notice,
        sortKey: notice.createdAt || '',
      });
    }

    return list.sort((x, y) => compareInstants(x.sortKey, y.sortKey));
  }, [messages, activities, memoryExtractions]);

  const activeAnchorId = find?.messageId ?? seekAnchorId ?? focusAnchorId;
  const seekAnchorIndex = useMemo(
    () => (activeAnchorId ? rows.findIndex((row) => row.message?.id === activeAnchorId) : -1),
    [rows, activeAnchorId]
  );

  /**
   * The rendered window: the last MAX_RENDERED rows, plus a bounded span around
   * an anchored (sought) row older than the tail. The spans are concatenated in
   * list order and merge when they touch, so downstream code can treat
   * `visible` as one ascending run of rows.
   */
  const renderWindow = useMemo(() => {
    const tailStart = Math.max(0, rows.length - MAX_RENDERED);
    if (seekAnchorIndex < 0 || seekAnchorIndex >= tailStart) {
      return {
        visible: rows.slice(tailStart),
        hiddenBefore: tailStart,
        hiddenBetween: 0,
        gapAt: null as number | null,
        anchored: false,
      };
    }
    const anchorStart = Math.max(0, seekAnchorIndex - SEEK_CONTEXT_ROWS);
    const anchorEnd = Math.min(rows.length, seekAnchorIndex + SEEK_CONTEXT_ROWS + 1);
    if (anchorEnd >= tailStart) {
      // The anchored span already reaches the tail: render one span, not two.
      return {
        visible: rows.slice(anchorStart),
        hiddenBefore: anchorStart,
        hiddenBetween: 0,
        gapAt: null as number | null,
        anchored: true,
      };
    }
    return {
      visible: [...rows.slice(anchorStart, anchorEnd), ...rows.slice(tailStart)],
      hiddenBefore: anchorStart,
      hiddenBetween: tailStart - anchorEnd,
      gapAt: anchorEnd - anchorStart,
      anchored: true,
    };
  }, [rows, seekAnchorIndex]);

  const visible = renderWindow.visible;
  const jumpToLatest = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    releaseFocus();
    setFocusAnchorId(null);
    el.scrollTop = el.scrollHeight;
    pinnedTopRef.current = el.scrollTop;
    autoFollowRef.current = true;
    setAtBottom(true);
  }, [releaseFocus]);
  const toggleAutoScroll = useCallback(() => {
    const next = !autoScrollRef.current;
    setChatAutoScroll(next);
    if (next) jumpToLatest();
  }, [jumpToLatest]);

  const isEmpty = !loading && messages.length === 0 && activities.size === 0;

  // Compaction points come from the full sorted list, so a compaction at the
  // top of the render-capped tail still finds its predecessor.
  const compactionMessageIds = useMemo(() => computeCompactionMessageIds(rows), [rows]);

  // Trim dimming comes from the rendered rows, not the full list: a boundary
  // the render cap cut off is offscreen for the reader and gets the same
  // marker as one outside the loaded page.
  const trimView = useMemo(() => computeTrimView(visible, trim), [visible, trim]);

  const seek = trim?.seek ?? null;
  const firstRetainedId = trim?.firstRetainedId;
  const lastRetainedId = trim?.lastRetainedId;
  const seekUnreachableFirst = unreachableSeekId != null && unreachableSeekId === firstRetainedId;
  const seekUnreachableLast = unreachableSeekId != null && unreachableSeekId === lastRetainedId;

  const scrollSignature = useMemo(
    () =>
      visible
        .map((row) => {
          const messagePart = row.message
            ? [
                row.message.id,
                row.message.content.length,
                row.message.thinkingContent?.length ?? 0,
                row.message.toolActivity?.length ?? 0,
              ].join(':')
            : 'no-message';
          const activityPart = row.activity
            ? [
                row.activity.runId,
                row.activity.status,
                activityStepsSignature(row.activity.steps),
              ].join(':')
            : 'no-activity';
          return `${row.key}|${messagePart}|${activityPart}`;
        })
        .join('|'),
    [visible]
  );

  // Initial scroll: to the bottom, or to the focused message on a search-hit
  // open. A layout effect, so the user never sees the intermediate position.
  useLayoutEffect(() => {
    if (hasInitializedScrollRef.current) return;
    if (visible.length === 0) return;
    const el = ref.current;
    if (!el) return;
    hasInitializedScrollRef.current = true;
    if (focusMessageId) {
      // The focus effect below places the message. autoFollow stays off so
      // the tail pin cannot pull the view away from it.
      autoFollowRef.current = false;
    } else {
      el.scrollTop = el.scrollHeight;
      pinnedTopRef.current = el.scrollTop;
      autoFollowRef.current = true;
    }
    // focusMessageId is left out of deps on purpose: this effect is one-shot
    // and must not re-run when focusMessageId resolves after the first paint.
  }, [visible.length]);

  // A focus open lands the message on the first render that contains it, once
  // per navigation request. A navigation (a message chip, a search hit) also
  // pins and highlights it, and every later render re-places it before paint:
  // the activity log usually lands after the messages and grows the rows above.
  useLayoutEffect(() => {
    // The render window follows the current focus only.
    if (focusAnchorId !== null && focusAnchorId !== focusMessageId) setFocusAnchorId(null);
    if (!focusMessageId) {
      // A reload cleared the anchor; whatever arrives next is a new focus.
      releaseFocus();
      return;
    }
    if (focusedRequestRef.current !== focusRequestId) {
      focusedRequestRef.current = focusRequestId;
      focusedIdRef.current = null;
    }
    if (focusedIdRef.current === focusMessageId) {
      placeFocusTarget();
      return;
    }
    if (!findMessage(focusMessageId)) {
      // Loaded but cut by the render cap: anchor the window on it, then land.
      if (rows.some((row) => row.message?.id === focusMessageId)) {
        setFocusAnchorId(focusMessageId);
      }
      return;
    }
    focusedIdRef.current = focusMessageId;
    autoFollowRef.current = false;
    setFocusAnchorId(focusMessageId);
    // A land-only focus also drops any earlier pin and highlight.
    focusHeldRef.current = holdFocus;
    focusPinRef.current = holdFocus ? focusMessageId : null;
    setHighlightId(holdFocus ? focusMessageId : null);
    placeFocusTarget(focusMessageId);
  }, [
    focusMessageId,
    focusRequestId,
    focusAnchorId,
    holdFocus,
    rows,
    scrollSignature,
    findMessage,
    placeFocusTarget,
    releaseFocus,
  ]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Restore the scroll position once after a "Load more" prepend.
    if (restoreScrollRef.current) {
      const { prevHeight } = restoreScrollRef.current;
      restoreScrollRef.current = null;
      const heightDelta = el.scrollHeight - prevHeight;
      if (heightDelta > 0) {
        el.scrollTop = el.scrollTop + heightDelta;
      }
      return;
    }
    // Initial scroll is handled by useLayoutEffect above.
    if (!hasInitializedScrollRef.current) return;
    // After mount: only follow if the user hasn't scrolled up.
    if (!following()) return;
    const frame = requestAnimationFrame(() => {
      // Re-check inside rAF: a focus open may have cleared autoFollowRef
      // between when this rAF was scheduled and when it fires.
      if (!following()) return;
      el.scrollTop = el.scrollHeight;
      pinnedTopRef.current = el.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollSignature]);

  // Rows keep changing height after the pin (an image loads, a diagram
  // renders, a disclosure opens) without moving the scroll signature, so any
  // row resize re-places a pinned focus message, or re-pins the tail while the
  // user follows it. The observer lives as long as the list element, which the
  // empty state replaces.
  const rowObserverRef = useRef<{ observer: ResizeObserver; observed: Set<Element> } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!hasInitializedScrollRef.current) return;
      if (focusPinRef.current) {
        placeFocusTarget();
        return;
      }
      if (!following()) return;
      if (restoreScrollRef.current) return;
      el.scrollTop = el.scrollHeight;
      pinnedTopRef.current = el.scrollTop;
    });
    // The list itself too: when the viewport shrinks (the composer's status
    // bar appears for a live run) the tail must stay in view.
    observer.observe(el);
    rowObserverRef.current = { observer, observed: new Set() };
    return () => {
      observer.disconnect();
      rowObserverRef.current = null;
    };
  }, [isEmpty]);
  useEffect(() => {
    const el = ref.current;
    const rows = rowObserverRef.current;
    if (!el || !rows) return;
    const current = new Set(Array.from(el.children));
    for (const child of rows.observed) {
      if (current.has(child)) continue;
      rows.observer.unobserve(child);
      rows.observed.delete(child);
    }
    for (const child of current) {
      if (rows.observed.has(child)) continue;
      rows.observer.observe(child);
      rows.observed.add(child);
    }
  }, [scrollSignature, isEmpty]);

  /**
   * Seeking the viewer: a trim handle drag and "Jump to prefix/tail" both
   * arrive as one `seek` request. The boundary lands centered, not smooth: a
   * drag changes it every few hundred ms and queued smooth scrolls would fight.
   * A target loaded but cut by the render cap anchors the window; one not
   * loaded pages until it lands or MAX_SEEK_PAGE_LOADS runs out. A landed
   * seek is consumed once (`seekedBoundaryRef`), so it never re-fires.
   */
  useEffect(() => {
    if (!seek) {
      seekedBoundaryRef.current = null;
      seekAttemptNonceRef.current = null;
      seekHoldRef.current?.();
      setUnreachableSeekId((prev) => (prev === null ? prev : null));
      return;
    }
    if (seekedBoundaryRef.current === seek.nonce) return;

    // A new request starts with a fresh page budget, no verdict, and no hold
    // left over from wherever the previous one landed.
    if (seekAttemptNonceRef.current !== seek.nonce) {
      seekAttemptNonceRef.current = seek.nonce;
      seekPageLoadsRef.current = 0;
      seekHoldRef.current?.();
      setUnreachableSeekId((prev) => (prev === null ? prev : null));
    }

    const el = ref.current?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(seek.messageId)}"]`
    );
    if (el) {
      seekedBoundaryRef.current = seek.nonce;
      setUnreachableSeekId((prev) => (prev === null ? prev : null));
      releaseFocus();
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      // A seek is the user's own navigation; jump-to-bottom must not undo it.
      autoFollowRef.current = false;
      const container = ref.current;
      if (container) seekHoldRef.current = holdOnTarget(container, el);
      return;
    }

    if (rows.some((row) => row.message?.id === seek.messageId)) {
      setSeekAnchorId(seek.messageId);
      return;
    }

    // Not loaded. Wait out a page that is already on its way rather than
    // stacking a second request on top of it.
    if (paginating) return;

    // Which way to page. The kept range is ordered (first ≤ last), so a loaded
    // other boundary settles the direction. With neither loaded, prefer older:
    // the prefix handle is the one people drag, and the tail is usually loaded.
    const targetIsFirst = seek.messageId === firstRetainedId;
    const otherBoundaryId = targetIsFirst ? lastRetainedId : firstRetainedId;
    const otherLoaded =
      otherBoundaryId != null && rows.some((row) => row.message?.id === otherBoundaryId);
    const older = otherLoaded ? targetIsFirst : hasMoreOlder;

    const canPage = older ? hasMoreOlder && !!onLoadOlder : hasMoreNewer && !!onLoadNewer;
    if (!canPage || seekPageLoadsRef.current >= MAX_SEEK_PAGE_LOADS) {
      // Out of pages: stop asking and say the jump failed. The request stays
      // pending (one querySelector per render), so a boundary that turns up
      // another way (a reload, a live update) still lands the jump.
      setUnreachableSeekId(seek.messageId);
      return;
    }
    seekPageLoadsRef.current += 1;
    if (older) handleLoadOlder();
    else onLoadNewer?.();
  }, [
    seek,
    scrollSignature,
    rows,
    firstRetainedId,
    lastRetainedId,
    hasMoreOlder,
    hasMoreNewer,
    paginating,
    handleLoadOlder,
    onLoadOlder,
    onLoadNewer,
    releaseFocus,
  ]);

  useEffect(() => {
    if (!find) {
      findRequestRef.current = null;
      return;
    }
    const element = ref.current?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(find.messageId)}"]`
    );
    if (!element) return;
    autoFollowRef.current = false;
    const shouldScroll = findRequestRef.current !== find.request;
    findRequestRef.current = find.request;
    if (shouldScroll) {
      releaseFocus();
      element.scrollIntoView({ block: 'center' });
    }
    const clear = highlightConversation(
      element,
      find.query,
      find.caseSensitive,
      find.occurrence,
      shouldScroll
    );
    return clear;
  }, [find?.request, visible, renderMode]);

  if (isEmpty) {
    return (
      <div
        className={styles.list}
        ref={ref}
        onScroll={handleScroll}
        onWheel={markUserScrollIntent}
        onTouchMove={markUserScrollIntent}
        onKeyDown={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
        onFocus={markUserScrollIntent}
        data-testid="message-list"
      >
        {!failed && !hideEmptyNote && <div className={styles.empty}>No messages yet</div>}
      </div>
    );
  }

  return (
    <div className={styles.listFrame}>
      <div
        className={styles.list}
        ref={ref}
        onScroll={handleScroll}
        onWheel={markUserScrollIntent}
        onTouchMove={markUserScrollIntent}
        onKeyDown={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
        onFocus={markUserScrollIntent}
        data-testid="message-list"
      >
        {hasMoreOlder && (
          <Button
            variant="ghost"
            size="sm"
            className={styles.loadMoreAnchor}
            onClick={handleLoadOlder}
            loading={paginating}
            loadingText="Loading…"
          >
            Load earlier messages
          </Button>
        )}
        {pageError?.edge === 'older' && !paginating && (
          <div className={styles.pageError} role="alert" data-tid="pageErrorOlder">
            Couldn’t load earlier messages: {pageError.message}
          </div>
        )}
        {renderWindow.hiddenBefore > 0 && (
          <div
            className={styles.truncationNotice}
            role="status"
            data-tid="renderHiddenBefore"
            data-hidden={renderWindow.hiddenBefore}
          >
            {renderWindow.hiddenBefore} earlier{' '}
            {renderWindow.hiddenBefore === 1 ? 'entry' : 'entries'} hidden —{' '}
            {renderWindow.anchored
              ? 'showing the messages around the boundary'
              : `showing the last ${MAX_RENDERED}`}{' '}
            for performance
          </div>
        )}
        {trimView.unlocatable && (
          <div className={styles.trimOffscreen} role="status" data-tid="trimBoundariesOffscreen">
            Both trim boundaries are outside this view — scroll or load more to see the cut
            {(seekUnreachableFirst || seekUnreachableLast) && <SeekUnreachableNote />}
          </div>
        )}
        {trimView.firstBoundaryAbove && (
          <div className={styles.trimOffscreen} role="status" data-tid="trimFirstBoundaryAbove">
            The first kept message is earlier than this view — everything above it will be deleted
            {seekUnreachableFirst && <SeekUnreachableNote />}
          </div>
        )}
        {visible.map((row, index) => {
          const showCompaction = !!row.message && compactionMessageIds.has(row.message.id);
          const doomed = !!row.message && trimView.doomedIds.has(row.message.id);
          const highlighted = highlightId !== null && row.message?.id === highlightId;
          return (
            <Fragment key={row.key}>
              {index === renderWindow.gapAt && (
                <div
                  className={styles.truncationNotice}
                  role="status"
                  data-tid="renderHiddenBetween"
                  data-hidden={renderWindow.hiddenBetween}
                >
                  {renderWindow.hiddenBetween} further{' '}
                  {renderWindow.hiddenBetween === 1 ? 'entry' : 'entries'} hidden between here and
                  the last {MAX_RENDERED}
                </div>
              )}
              {showCompaction && <CompactionDivider />}
              {row.extraction ? (
                <MemoryExtractionLine
                  notice={row.extraction}
                  agentName={agentNameById.get(row.extraction.agentId)}
                  onOpen={onOpenMemoryNotice}
                />
              ) : (
                /*
                  The wrapper is unconditional so trimming cannot change the list's
                  layout: `.list > *` styles whichever element is the flex item, and
                  swapping that element in and out under the user would reflow the
                  whole stream the moment the panel opened.
                */
                <div
                  className={
                    [doomed && styles.trimDoomed, highlighted && styles.focusHighlight]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  data-trim-doomed={doomed ? 'true' : undefined}
                  data-focus-highlight={highlighted ? 'true' : undefined}
                  aria-current={highlighted ? 'true' : undefined}
                >
                  <MessageRow
                    message={row.message}
                    activity={row.activity}
                    agentNameById={agentNameById}
                    renderMode={renderMode}
                    author={authorFor ? authorFor(row) : null}
                    tagAvatarFor={tagAvatarFor}
                  />
                </div>
              )}
            </Fragment>
          );
        })}
        {trimView.lastBoundaryBelow && (
          <div className={styles.trimOffscreen} role="status" data-tid="trimLastBoundaryBelow">
            The last kept message is later than this view — everything below it will be deleted
            {seekUnreachableLast && <SeekUnreachableNote />}
          </div>
        )}
        {hasMoreNewer && paginating && (
          <div className={styles.forwardLoading} role="status">
            Loading newer messages…
          </div>
        )}
        {pageError?.edge === 'newer' && !paginating && (
          <div className={styles.pageError} role="alert" data-tid="pageErrorNewer">
            Couldn’t load newer messages: {pageError.message}
          </div>
        )}
      </div>
      <div className={styles.scrollControls} data-testid="scroll-controls">
        {!atBottom && (
          <button
            type="button"
            className={styles.scrollButton}
            onClick={jumpToLatest}
            data-testid="jump-to-latest"
          >
            ↓ Latest
          </button>
        )}
        <button
          type="button"
          className={styles.scrollButton}
          aria-pressed={autoScroll}
          onClick={toggleAutoScroll}
          title={
            autoScroll
              ? 'Auto-scroll on: follows new messages. Click for manual.'
              : 'Manual scroll: the view stays put. Click to auto-scroll.'
          }
          data-testid="auto-scroll-toggle"
        >
          {autoScroll ? 'Auto-scroll' : 'Manual'}
        </button>
      </div>
    </div>
  );
};
